/**
 * XBRL Financial Time Series
 *
 * Fetches quarterly financial data from SEC EDGAR's XBRL companyfacts API.
 * No API key needed. Returns structured time series for fingerprinting.
 */

import { edgarFetch, RATE_LIMIT_MS } from "./index.js";
import { lookupCIK } from "./cik.js";

export interface FinancialSeries {
  ticker: string;
  concept: string;
  unit: string;
  data: Array<{ date: string; value: number; form: string }>;
}

/** Core financial concepts to fetch */
const CORE_CONCEPTS = [
  "us-gaap/Revenues",
  "us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax",
  "us-gaap/NetIncomeLoss",
  "us-gaap/OperatingIncomeLoss",
  "us-gaap/GrossProfit",
  "us-gaap/CostOfGoodsAndServicesSold",
  "us-gaap/InventoriesNet",
  "us-gaap/Assets",
  "us-gaap/CapitalExpendituresIncurredButNotYetPaid",
  "us-gaap/PaymentsToAcquirePropertyPlantAndEquipment",
  "us-gaap/OperatingCashFlow",
  "us-gaap/NetCashProvidedByOperatingActivities",
  "us-gaap/EarningsPerShareDiluted",
];

/**
 * Fetch XBRL financial data for a ticker.
 *
 * Returns quarterly time series for core financial concepts.
 * Falls back to alternate concept names (e.g. different revenue labels).
 */
export async function fetchFinancials(ticker: string): Promise<FinancialSeries[]> {
  const cik = await lookupCIK(ticker);
  if (!cik) return [];

  const cikPadded = String(cik).padStart(10, "0");
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikPadded}.json`;

  const r = await edgarFetch(url);
  if (!r.ok) return [];

  const data = await r.json() as {
    facts: Record<string, Record<string, {
      units: Record<string, Array<{
        end: string; val: number; form: string; fp: string; fy: number;
      }>>;
    }>>;
  };

  const results: FinancialSeries[] = [];

  for (const conceptPath of CORE_CONCEPTS) {
    const [taxonomy, concept] = conceptPath.split("/");
    const conceptData = data?.facts?.[taxonomy]?.[concept];
    if (!conceptData) continue;

    // Prefer USD units
    const units = conceptData.units;
    const unitKey = units["USD"] ? "USD" : units["USD/shares"] ? "USD/shares" : Object.keys(units)[0];
    if (!unitKey || !units[unitKey]) continue;

    // Filter to quarterly (10-Q) and annual (10-K) filings
    const points = units[unitKey]
      .filter(p => p.form === "10-Q" || p.form === "10-K")
      .filter(p => p.end && !isNaN(p.val))
      .map(p => ({ date: p.end, value: p.val, form: p.form }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Deduplicate by date (keep latest filing)
    const seen = new Set<string>();
    const deduped = [];
    for (let i = points.length - 1; i >= 0; i--) {
      if (!seen.has(points[i].date)) {
        seen.add(points[i].date);
        deduped.unshift(points[i]);
      }
    }

    if (deduped.length >= 4) {
      results.push({
        ticker: ticker.toUpperCase(),
        concept,
        unit: unitKey,
        data: deduped,
      });
    }
  }

  return results;
}
