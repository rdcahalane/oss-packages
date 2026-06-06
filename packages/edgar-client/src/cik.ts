/**
 * CIK (Central Index Key) resolution.
 *
 * Maps ticker symbols to SEC CIK numbers and vice versa.
 * Uses company_tickers.json — loaded once and cached.
 */

import { edgarFetch, RATE_LIMIT_MS } from "./index.js";

export interface CIKEntry {
  cik: number;
  ticker: string;
  name: string;
}

let _tickerMap: Map<string, CIKEntry> | null = null;
let _cikMap: Map<number, CIKEntry> | null = null;

/**
 * Load the full SEC ticker→CIK mapping. Cached after first call.
 */
export async function loadTickerMap(): Promise<Map<string, CIKEntry>> {
  if (_tickerMap) return _tickerMap;

  const r = await edgarFetch("https://www.sec.gov/files/company_tickers.json");
  if (!r.ok) throw new Error(`Failed to load company_tickers.json: ${r.status}`);
  const data = await r.json() as Record<string, { cik_str: number; ticker: string; title: string }>;

  _tickerMap = new Map();
  _cikMap = new Map();

  for (const entry of Object.values(data)) {
    const e: CIKEntry = {
      cik: entry.cik_str,
      ticker: entry.ticker.toUpperCase(),
      name: entry.title,
    };
    _tickerMap.set(e.ticker, e);
    _cikMap.set(e.cik, e);
  }

  return _tickerMap;
}

/**
 * Resolve ticker → CIK number. Returns null if not found.
 */
export async function lookupCIK(ticker: string): Promise<number | null> {
  const map = await loadTickerMap();
  return map.get(ticker.toUpperCase())?.cik ?? null;
}

/**
 * Resolve CIK → ticker symbol. Returns null if not found.
 */
export async function lookupTicker(cik: number): Promise<string | null> {
  if (!_cikMap) await loadTickerMap();
  return _cikMap!.get(cik)?.ticker ?? null;
}
