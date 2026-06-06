/**
 * pptx-extractor
 *
 * Extract per-slide text and structured metadata from a PPTX buffer.
 *
 * A PPTX file is a ZIP archive. This package uses fflate to unzip it,
 * parses each `ppt/slides/slideN.xml` for `<a:t>` text run elements,
 * and optionally runs configurable regex extractors over the slide text
 * to pull out structured fields (percentages, IDs, headlines, etc.).
 *
 * Designed for processing research deck slides where each slide contains
 * a consistent pattern of structured data (e.g. survey stats, percentages,
 * labelled values). The extractor patterns are fully caller-configurable —
 * no hardcoded assumptions about your slide format.
 *
 * Works in any runtime that supports ArrayBuffer: Node.js, Cloudflare Workers,
 * Deno, browsers.
 *
 * Usage:
 *   import { extractSlides, parseSlideFields } from "pptx-extractor";
 *
 *   // Step 1 — extract raw slide text
 *   const slides = await extractSlides(arrayBuffer);
 *   // → [{ slideNum: 1, slideText: "...", textParts: ["...", "..."] }, ...]
 *
 *   // Step 2 — parse structured fields from each slide
 *   const fields = parseSlideFields(slides[0].slideText, slides[0].textParts, {
 *     id:        { pattern: /\b(Q\d{1,4})\b/, group: 1 },
 *     leaderPct: { pattern: /[Ll]eaders?\s*:?\s*(\d{1,3}(?:\.\d)?)\s*%/, group: 1, asFloat: true },
 *     headline:  { strategy: "longest-insight" },
 *   });
 *   // → { id: "Q263", leaderPct: 72.0, headline: "Leaders are 2.3x more likely to..." }
 *
 *   // Or use the combined helper:
 *   const parsed = await extractAndParse(arrayBuffer, myExtractorConfig);
 */

import { unzipSync } from "fflate";

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single extracted slide */
export interface Slide {
  slideNum: number;
  /** All text run values joined with spaces */
  slideText: string;
  /** Individual <a:t> text run values, in document order */
  textParts: string[];
}

/** Configuration for a single extracted field */
export type FieldExtractorConfig =
  | RegexExtractorConfig
  | HeadlineExtractorConfig
  | SectionExtractorConfig;

/** Extract via regex. `group` defaults to 1. Set `asFloat: true` to parse as number. */
export interface RegexExtractorConfig {
  strategy?: "regex";
  pattern: RegExp;
  group?: number;
  asFloat?: boolean;
}

/**
 * Find the best "headline" — the longest text part that reads like an
 * insight sentence (contains verbs or comparative language).
 * Falls back to the longest text part overall.
 */
export interface HeadlineExtractorConfig {
  strategy: "longest-insight";
  /** Minimum character length to consider (default 40) */
  minLength?: number;
  /** Maximum character length to consider (default 300) */
  maxLength?: number;
  /** Regex that marks a part as insight-like (default: common English verbs) */
  insightPattern?: RegExp;
  /** Parts matching this pattern are skipped (default: short labels / numbers) */
  skipPattern?: RegExp;
}

/**
 * Extract a section header — the first text part that looks like a title.
 */
export interface SectionExtractorConfig {
  strategy: "section-header";
  minLength?: number;
  maxLength?: number;
  /** Parts matching this pattern are skipped */
  skipPattern?: RegExp;
}

/** Map of field names to their extractor configurations */
export type ExtractorMap = Record<string, FieldExtractorConfig>;

/** Extracted field values */
export type ParsedFields = Record<string, string | number | null>;

// ── Core extraction ────────────────────────────────────────────────────────────

/**
 * Unzip a PPTX buffer and return the text of every slide, in order.
 *
 * @param buffer  ArrayBuffer of the PPTX file
 * @returns       Array of Slide objects, sorted by slide number
 */
export function extractSlides(buffer: ArrayBuffer): Slide[] {
  const uint8 = new Uint8Array(buffer);
  const unzipped = unzipSync(uint8);

  const slideEntries = Object.keys(unzipped)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)![1]);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)![1]);
      return na - nb;
    });

  return slideEntries.map((slidePath) => {
    const slideNum = parseInt(slidePath.match(/slide(\d+)\.xml/)![1]);
    const xml = new TextDecoder().decode(unzipped[slidePath]);
    const textParts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    const slideText = textParts.join(" ");
    return { slideNum, slideText, textParts };
  });
}

// ── Field parser ───────────────────────────────────────────────────────────────

const DEFAULT_SKIP = /^\s*$|^\d+%$|^\d+$|^[\d.]+[xX]$|^[nN]\s*=\s*\d+$/;
const DEFAULT_INSIGHT = /\b(likely|more|less|better|higher|lower|greater|tend|report|have|use|deploy|show|find|achieve|enable|reduce|increase)\b/i;

/**
 * Parse structured fields from a single slide's text using caller-supplied
 * extractor configurations.
 *
 * @param slideText  Full slide text (textParts joined with spaces)
 * @param textParts  Individual text run values from the slide
 * @param extractors Map of field name → extractor configuration
 * @returns          Map of field name → extracted value (string, number, or null)
 */
export function parseSlideFields(
  slideText: string,
  textParts: string[],
  extractors: ExtractorMap,
): ParsedFields {
  const result: ParsedFields = {};

  for (const [field, config] of Object.entries(extractors)) {
    if (!config) {
      result[field] = null;
      continue;
    }

    const strategy = "strategy" in config ? config.strategy : "regex";

    if (strategy === "regex" || strategy === undefined) {
      const cfg = config as RegexExtractorConfig;
      const match = slideText.match(cfg.pattern);
      if (!match) {
        result[field] = null;
        continue;
      }
      const group = cfg.group ?? 1;
      const raw = match[group] ?? null;
      result[field] = raw !== null && cfg.asFloat ? parseFloat(raw) : raw;
      continue;
    }

    if (strategy === "longest-insight") {
      const cfg = config as HeadlineExtractorConfig;
      const minLen = cfg.minLength ?? 40;
      const maxLen = cfg.maxLength ?? 300;
      const skip = cfg.skipPattern ?? DEFAULT_SKIP;
      const insightLike = cfg.insightPattern ?? DEFAULT_INSIGHT;

      const candidates = textParts.filter(
        (t) => t.length >= minLen && t.length <= maxLen && !skip.test(t),
      );
      const insights = candidates.filter((t) => insightLike.test(t));
      result[field] = insights[0] ?? candidates[0] ?? null;
      continue;
    }

    if (strategy === "section-header") {
      const cfg = config as SectionExtractorConfig;
      const minLen = cfg.minLength ?? 20;
      const maxLen = cfg.maxLength ?? 200;
      const skip = cfg.skipPattern ?? DEFAULT_SKIP;

      const header = textParts.find(
        (t) =>
          t.length >= minLen &&
          t.length <= maxLen &&
          !skip.test(t) &&
          !/^\d/.test(t),
      );
      result[field] = header ?? null;
      continue;
    }

    result[field] = null;
  }

  return result;
}

// ── Combined helper ────────────────────────────────────────────────────────────

export interface ParsedSlide extends Slide {
  fields: ParsedFields;
}

/**
 * Extract slides from a PPTX buffer and parse structured fields from each,
 * skipping slides with fewer than `minTextLength` characters (blank/divider slides).
 *
 * @param buffer       ArrayBuffer of the PPTX file
 * @param extractors   Field extractor configuration
 * @param minTextLength Minimum slide text length to include (default 20)
 */
export function extractAndParse(
  buffer: ArrayBuffer,
  extractors: ExtractorMap,
  minTextLength = 20,
): ParsedSlide[] {
  const slides = extractSlides(buffer);
  return slides
    .filter((s) => s.slideText.trim().length >= minTextLength)
    .map((s) => ({
      ...s,
      fields: parseSlideFields(s.slideText, s.textParts, extractors),
    }));
}

// ── Pre-built extractor configs ───────────────────────────────────────────────

/**
 * Ready-to-use extractor config for survey and benchmark slides.
 *
 * Extracts: questionId, leaderPct, followerPct, lfMultiplier, sampleN,
 *           chartHeadline, slideSection.
 *
 * Usage:
 *   const slides = extractAndParse(buffer, SURVEY_DECK_EXTRACTORS);
 *   slides[0].fields.leaderPct  // → 72.0
 *   slides[0].fields.chartHeadline  // → "Leaders are 2.3x more likely to..."
 */
export const SURVEY_DECK_EXTRACTORS: ExtractorMap = {
  questionId: {
    pattern: /\b(Q\d{1,4})\b/,
    group: 1,
  },
  leaderPct: {
    pattern: /[Ll]eaders?\s*:?\s*(\d{1,3}(?:\.\d)?)\s*%/,
    group: 1,
    asFloat: true,
  },
  followerPct: {
    pattern: /[Ff]ollowers?\s*:?\s*(\d{1,3}(?:\.\d)?)\s*%/,
    group: 1,
    asFloat: true,
  },
  lfMultiplier: {
    pattern: /(\d+(?:\.\d+)?)[xX]\s*more likely/i,
    group: 1,
    asFloat: true,
  },
  sampleN: {
    pattern: /\bn\s*=\s*(\d{2,4})\b/i,
    group: 1,
    asFloat: true,
  },
  chartHeadline: {
    strategy: "longest-insight",
    minLength: 40,
    maxLength: 300,
    skipPattern: /^\s*$|^\d+%$|^[Ll]eaders?$|^[Ff]ollowers?$|^n\s*=|^Source:|^\d+$|^[\d.]+[xX]$/,
  },
  slideSection: {
    strategy: "section-header",
    minLength: 20,
    maxLength: 200,
  },
};
