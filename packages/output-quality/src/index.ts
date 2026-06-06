/**
 * output-quality
 *
 * AI quality pipeline for markdown documents before export (PPTX, PDF, DOCX).
 *
 * Three operations, used in sequence:
 *   1. reviewContent   — Haiku checks if content is a real deliverable (score 1–10, approve ≥7)
 *   2. reviseContent   — Sonnet rewrites if review fails, using the reviewer's instructions
 *   3. compressForPptx — Haiku condenses each ## section to ≤700 body chars for slide fit
 *
 * Usage:
 *   import { createOutputQuality } from "output-quality";
 *
 *   const q = createOutputQuality({ apiKey: process.env.ANTHROPIC_API_KEY });
 *
 *   const review = await q.reviewContent(markdown);
 *   if (!review.approved) {
 *     markdown = await q.reviseContent(markdown, review.revision_instructions);
 *   }
 *   // styleExamples: optional examples string from your own corpus
 *   markdown = await q.compressForPptx(markdown, styleExamples);
 *
 * All three methods fail open — they return the original content on error.
 * The caller is responsible for fetching any optional style examples.
 *
 * Works in Node.js and Cloudflare Workers (no Node-specific APIs used).
 */

import Anthropic from '@anthropic-ai/sdk';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReviewResult {
  approved: boolean;
  score: number;
  issues: string[];
  revision_instructions: string;
}

export interface OutputQualityOptions {
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model for review + compress passes. Default: claude-sonnet-4-6 */
  reviewModel?: string;
  /** Model for revision pass. Default: claude-sonnet-4-6 */
  reviseModel?: string;
}

export interface OutputQuality {
  reviewContent(content: string): Promise<ReviewResult>;
  reviseContent(content: string, instructions: string, systemPrompt?: string): Promise<string>;
  compressForPptx(content: string, styleExamples?: string | null): Promise<string>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Empirical body-character budget per ## section.
 * Sections exceeding this will overflow a single PPTX slide into a (cont.) slide.
 * Excludes table rows, headings, and separator lines.
 */
export const PPTX_SECTION_CHAR_LIMIT = 700;

/**
 * Count body characters in a markdown section (## heading block).
 * Excludes table rows (|), headings (#), and separator lines (---).
 */
export function countBodyChars(section: string): number {
  return section.split('\n').filter(l => {
    const t = l.trim();
    return t.length > 5
      && !t.startsWith('#')
      && !t.startsWith('|')
      && !t.match(/^[-=]{3,}$/);
  }).reduce((sum, l) => sum + l.trim().length, 0);
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createOutputQuality(opts: OutputQualityOptions = {}): OutputQuality {
  const client  = new Anthropic({ apiKey: opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] });
  const REVIEW  = opts.reviewModel ?? 'claude-sonnet-4-6';
  const REVISE  = opts.reviseModel ?? 'claude-sonnet-4-6';

  // ── Review ─────────────────────────────────────────────────────────────────

  async function reviewContent(content: string): Promise<ReviewResult> {
    const prompt = `You are a high-standard editorial reviewer for professional markdown deliverables.

FIRST — determine if this is actually an analyst deliverable. If the content is ANY of these, immediately return {"approved": false, "score": 1, "issues": ["Not an analyst deliverable — this is a conversational AI response"], "revision_instructions": ""}:
- A conversational AI message (starts with "Let me...", "I'll...", "Sure...", "I searched...", "The search...", "I found...")
- A request for clarification or more information from the user
- A search result summary or data retrieval message
- An apology or error message
- A previous export confirmation message

Only if it IS a genuine deliverable (report, sprint deck, inquiry summary, analysis, brief, memo, framework), then review against these criteria:
1. COMPLETENESS — Is every section fully written with substantive prose? Or is it a skeleton/outline with headers only?
2. DOMAIN VOICE — Are specific frameworks named, data points cited, and concrete entities used?
3. EXECUTIVE IMPACT — Would an informed stakeholder find this credible and actionable?
4. FIT & FINISH — No AI preamble ("Let me...", "I'll follow..."), no raw markdown artifacts, no placeholder labels like "SLIDE 1 -- COVER" with no body

Score 1-10. Approve if score >= 7.

Return ONLY valid JSON:
{"approved": true/false, "score": 1-10, "issues": ["..."], "revision_instructions": "Specific instructions for what to rewrite and how."}

CONTENT TO REVIEW (first 6000 chars):
${content.slice(0, 6000)}`;

    try {
      const msg = await client.messages.create({
        model: REVIEW,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = (msg.content[0] as { text: string })?.text ?? '';
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      return JSON.parse(cleaned) as ReviewResult;
    } catch {
      return { approved: true, score: 8, issues: [], revision_instructions: '' }; // fail open
    }
  }

  // ── Revise ─────────────────────────────────────────────────────────────────

  async function reviseContent(
    content: string,
    instructions: string,
    systemPrompt?: string,
  ): Promise<string> {
    const userPrompt = `Revision instructions from the quality reviewer:
${instructions}

Original content to revise:
${content}

Write the COMPLETE revised version. Keep all substantive content. Fix only the identified issues — full prose for every section, no outlines, no AI preamble, no placeholder labels. Use markdown headings (##, ###) for structure. Reference the document's actual data and frameworks from context.`;

    try {
      const msg = await client.messages.create({
        model: REVISE,
        max_tokens: 6000,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: 'user', content: userPrompt }],
      });
      return (msg.content[0] as { text: string })?.text ?? content;
    } catch {
      return content; // fail open
    }
  }

  // ── Compress ───────────────────────────────────────────────────────────────

  async function compressForPptx(
    content: string,
    styleExamples: string | null = null,
  ): Promise<string> {
    const sections = content.split(/(?=^## )/m);
    const needsCompression = sections.some(s => countBodyChars(s) > PPTX_SECTION_CHAR_LIMIT);
    if (!needsCompression) return content;

    const goldSection = styleExamples
      ? `\nSTYLE REFERENCE — Study the section density, bullet conciseness, and prose style. Your output should match this quality level:\n\n${styleExamples}\n\n---\n\n`
      : '';

    const prompt = `You are compressing a consultant document to fit on PowerPoint slides.
Each ## section must contain AT MOST 700 characters of body text (bullets + prose).
Do NOT count table rows (lines starting with |) or ## headings toward this limit.
Count characters precisely — you can count actual characters in each non-table, non-heading paragraph.
${goldSection}
SLIDE TRANSLATION RULES — this is not a copy-paste task. You are translating an analyst document into slide-ready content:
- ## headings are slide titles. Remove any "Slide N:" or "Slide N." prefix (e.g. "## Slide 3: Title" → "## Title")
- Each slide needs ONE clear assertion the audience takes away — make it the first bullet or subtitle line
- Bullets must be conclusions, not descriptions. Bad: "Three issues were identified." Good: "Three structural gaps block the roadmap."
- Cut filler transitions ("This maps to...", "It is worth noting that...") — every line must earn its place

STRICT RULES — violations are unacceptable:
- NEVER change or drop any number: dollar amounts, percentages, weights, correlations
- NEVER remove named entities: company names, person names, product names
- NEVER remove direct quotes (lines starting with > or containing quotation marks around a full sentence)
- NEVER alter table rows — tables pass through unchanged
- Combine related bullets into single crisp assertion sentences to reduce line count
- REMOVE any percentage claim that has no source in the surrounding text unless the sentence names a specific study, report, or data source
- If a section has ≤12 content lines already, apply translation rules but do not compress further

PROSE-TO-BULLETS RULE (most important for slide readability):
- Any continuous prose paragraph (text not starting with - or * or >, and longer than 100 characters) MUST be converted into 2–3 tight assertion bullets. Each bullet = one crisp sentence. Do not preserve prose paragraphs as-is — a wall of text on a PowerPoint slide fails.
- Exception: blockquotes (lines starting with >) and the sentence immediately under a ## heading (the "subtitle" line) may remain as prose if they are ≤80 characters.

DIAGNOSTIC DATA SURFACING RULE:
- If any section references diagnostic issue weights inline but the full diagnostic table only appears in an Appendix or later section, add a compact 2-column markdown table (| Issue | Weight |) with the top 3–4 items to the FIRST section that references these weights. Preserve the original appendix table unchanged.

Return the COMPLETE markdown with the same ## section structure. No preamble, no commentary.

${content}`;

    try {
      const msg = await client.messages.create({
        model: REVIEW,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      });
      const result = ((msg.content[0] as { text: string })?.text ?? '').trim();
      return result.length > content.length * 0.5 ? result : content; // reject suspiciously short output
    } catch {
      return content; // fail open
    }
  }

  return { reviewContent, reviseContent, compressForPptx };
}
