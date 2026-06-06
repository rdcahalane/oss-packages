/**
 * EDGAR Full-Text Search (EFTS)
 *
 * Search SEC filings by form type, date range, and content keywords.
 * Used by 8-K, Form 4, 10-K, DEF 14A scrapers.
 */

import { edgarFetch, RATE_LIMIT_MS } from "./index.js";

export interface FilingSearchResult {
  accessionNo: string;
  cik: number;
  ticker?: string;
  companyName: string;
  formType: string;
  filedAt: string;
  documentUrl: string;
  description?: string;
}

const EFTS_BASE = "https://efts.sec.gov/LATEST/search-index";

interface EFTSParams {
  /** Free-text query (e.g. '"Item 5.02"') */
  query?: string;
  /** Form types to search (e.g. "8-K", "10-K", "DEF 14A") */
  forms?: string;
  /** Start date (YYYY-MM-DD) */
  startDate?: string;
  /** End date (YYYY-MM-DD) */
  endDate?: string;
  /** Max results per page */
  count?: number;
  /** Start index for pagination */
  from?: number;
}

/**
 * Search EDGAR filings via the full-text search API.
 *
 * @example
 * // Find 8-K filings mentioning executive transitions in the last 90 days
 * const results = await searchFilings({
 *   query: '"Item 5.02"',
 *   forms: '8-K',
 *   startDate: '2025-01-01',
 * });
 */
export async function searchFilings(params: EFTSParams): Promise<FilingSearchResult[]> {
  const searchParams = new URLSearchParams();

  if (params.query) searchParams.set("q", params.query);
  if (params.forms) searchParams.set("forms", params.forms);
  if (params.startDate || params.endDate) {
    searchParams.set("dateRange", "custom");
    if (params.startDate) searchParams.set("startdt", params.startDate);
    if (params.endDate) searchParams.set("enddt", params.endDate);
  }
  searchParams.set("from", String(params.from ?? 0));
  searchParams.set("count", String(params.count ?? 40));

  const url = `${EFTS_BASE}?${searchParams}`;
  const r = await edgarFetch(url);
  if (!r.ok) return [];

  const data = await r.json() as {
    hits: {
      hits: Array<{
        _source: Record<string, unknown> & {
          display_names?: string[];
        };
      }>;
    };
  };

  const hits = data?.hits?.hits ?? [];
  const results: FilingSearchResult[] = [];

  for (const hit of hits) {
    const src = hit._source;
    const accNo = String(src.file_num ?? src.accession_no ?? "").replace(/-/g, "");
    const cik = Number(src.entity_id ?? src.cik ?? 0);

    results.push({
      accessionNo: accNo,
      cik,
      companyName: String(src.entity_name ?? src.display_names?.[0] ?? ""),
      formType: String(src.form_type ?? src.file_type ?? ""),
      filedAt: String(src.file_date ?? src.filed_at ?? ""),
      documentUrl: src.file_url
        ? String(src.file_url)
        : `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo}/`,
      description: String(src.display_description ?? ""),
    });
  }

  return results;
}
