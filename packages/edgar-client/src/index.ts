/**
 * edgar-client
 *
 * Unified SEC EDGAR client. Zero API key needed — all public data.
 *
 * Modules:
 *   - cik: Ticker → CIK resolution (cached)
 *   - efts: EDGAR Full-Text Search (8-K, 10-K, DEF 14A, etc.)
 *   - xbrl: XBRL financial time series (revenue, income, capex, etc.)
 *   - form4: Insider transaction parsing (officer/director names + trades)
 *   - filing8k: 8-K item extraction (5.02 exec transitions, 2.04 debt, 1.01 M&A)
 *
 * Rate limit: SEC allows 10 req/sec with proper User-Agent.
 * All functions enforce a courtesy delay.
 */

export { lookupCIK, lookupTicker, loadTickerMap, type CIKEntry } from "./cik.js";
export { searchFilings, type FilingSearchResult } from "./efts.js";
export { fetchFinancials, type FinancialSeries } from "./xbrl.js";
export { fetchForm4People, type Form4Person } from "./form4.js";
export { fetch8KEvents, type Event8K } from "./filing8k.js";

/** Shared EDGAR headers — SEC requires contact info in User-Agent */
export const EDGAR_HEADERS = {
  "User-Agent": "edgar-client/0.1.0 (opensource@example.com)",
  "Accept": "application/json",
  "Accept-Encoding": "gzip, deflate",
};

/** Courtesy delay between requests (ms) — SEC rate limit is 10/sec */
export const RATE_LIMIT_MS = 120;

export async function edgarFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = { ...EDGAR_HEADERS, ...(init?.headers as Record<string, string> ?? {}) };
  return fetch(url, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(30000) });
}
