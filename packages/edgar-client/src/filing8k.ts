/**
 * 8-K Filing Parser
 *
 * Extracts structured events from SEC 8-K filings:
 *   - Item 5.02: Executive transitions (appointments/departures)
 *   - Item 2.04: Debt triggers
 *   - Item 1.01: M&A/material agreements
 *   - Item 1.02: Contract terminations
 *   - Item 2.05: Workforce reductions
 *   - Item 4.02: Financial restatements
 *   - Item 1.05: Cybersecurity incidents
 */

import { searchFilings } from "./efts.js";
import { edgarFetch, RATE_LIMIT_MS } from "./index.js";

export interface Event8K {
  ticker?: string;
  companyName: string;
  cik: number;
  item: string;
  itemDescription: string;
  eventDate?: string;
  filingDate: string;
  accessionNo: string;
  documentUrl: string;
  /** Extracted people (for Item 5.02) */
  people?: Array<{
    name: string;
    role_raw?: string;
    direction: "appointment" | "departure" | "unknown";
  }>;
  /** Raw text snippet from the filing */
  excerpt?: string;
}

const ITEM_DESCRIPTIONS: Record<string, string> = {
  "1.01": "Entry into Material Agreement",
  "1.02": "Termination of Material Agreement",
  "1.05": "Material Cybersecurity Incident",
  "2.04": "Triggering Events (Debt Acceleration)",
  "2.05": "Costs of Workforce Reduction",
  "4.02": "Non-Reliance on Previously Issued Financial Statements",
  "5.02": "Departure/Election of Directors or Officers",
};

/**
 * Fetch 8-K events for a specific item type.
 *
 * @example
 * // Get executive transitions from the last 90 days
 * const events = await fetch8KEvents("5.02", { daysBack: 90 });
 */
export async function fetch8KEvents(
  item: string,
  opts: { daysBack?: number; limit?: number } = {}
): Promise<Event8K[]> {
  const daysBack = opts.daysBack ?? 90;
  const limit = opts.limit ?? 100;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - daysBack * 86400000);

  const filings = await searchFilings({
    query: `"Item ${item}"`,
    forms: "8-K",
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
    count: Math.min(limit, 40),
  });

  const events: Event8K[] = [];

  for (const filing of filings.slice(0, limit)) {
    const event: Event8K = {
      companyName: filing.companyName,
      cik: filing.cik,
      item,
      itemDescription: ITEM_DESCRIPTIONS[item] ?? `Item ${item}`,
      filingDate: filing.filedAt,
      accessionNo: filing.accessionNo,
      documentUrl: filing.documentUrl,
    };

    // Extract ticker from company name if available (pattern: "COMPANY NAME (TICKER)")
    const tickerMatch = filing.companyName.match(/\(([A-Z]{1,6})\)/);
    if (tickerMatch) event.ticker = tickerMatch[1];

    // For Item 5.02, try to extract people from the filing text
    if (item === "5.02") {
      try {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
        const docR = await edgarFetch(filing.documentUrl);
        if (docR.ok) {
          const text = await docR.text();
          event.people = extractPeopleFrom502(text);
          // Extract a short excerpt
          const idx = text.toLowerCase().indexOf("item 5.02");
          if (idx >= 0) {
            event.excerpt = text.slice(idx, idx + 500).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          }
        }
      } catch { /* skip extraction */ }
    }

    events.push(event);
  }

  return events;
}

/**
 * Extract people from Item 5.02 filing text.
 */
function extractPeopleFrom502(html: string): Event8K["people"] {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const people: NonNullable<Event8K["people"]> = [];
  const seen = new Set<string>();

  // Pattern: "appointed X as Y" or "resignation of X" etc.
  const patterns = [
    { re: /(?:appoint|elect|nam)\w*\s+([A-Z][a-z]+ (?:[A-Z]\. )?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:as|to)\s+([^.,]{3,50})/gi, dir: "appointment" as const },
    { re: /([A-Z][a-z]+ (?:[A-Z]\. )?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:has been|was)\s+(?:appoint|elect|nam)\w+\s+(?:as|to)\s+([^.,]{3,50})/gi, dir: "appointment" as const },
    { re: /(?:resign|depart|terminat|retir)\w*\s+(?:of\s+)?([A-Z][a-z]+ (?:[A-Z]\. )?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/gi, dir: "departure" as const },
    { re: /([A-Z][a-z]+ (?:[A-Z]\. )?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:has\s+)?(?:resign|depart|retir)\w+/gi, dir: "departure" as const },
  ];

  for (const { re, dir } of patterns) {
    for (const match of text.matchAll(re)) {
      const name = match[1]?.trim();
      const role = match[2]?.trim();
      if (name && name.length > 4 && name.includes(" ") && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        people.push({ name, role_raw: role, direction: dir });
      }
    }
  }

  return people;
}
