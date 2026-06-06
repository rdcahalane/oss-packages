/**
 * event-study-engine
 *
 * Compute excess returns at standard windows vs a benchmark ETF.
 *
 * Windows: T+1, T+5, T+10, T+30, T+90, T+180 trading days
 * Excess return = ticker return − benchmark return over the same window
 */

import { fetchPrices, type PricePoint } from "market-data-lite";

export interface EventStudyResult {
  ticker: string;
  eventDate: string;
  eventType?: string;
  benchmark: string;
  windows: Record<string, {
    days: number;
    tickerReturn: number;
    benchmarkReturn: number;
    excessReturn: number;
    startDate: string;
    endDate: string;
  }>;
}

export interface AggregateResult {
  eventType: string;
  count: number;
  windows: Record<string, {
    meanExcess: number;
    medianExcess: number;
    winRate: number;   // % of events where excess > 0
    stdDev: number;
  }>;
}

const WINDOWS = [1, 5, 10, 30, 90, 180] as const;

/**
 * Run an event study for a single event.
 *
 * @param ticker - Stock ticker (e.g. "ROK")
 * @param eventDate - Date of the event (YYYY-MM-DD)
 * @param benchmark - Benchmark ETF (default: "XLI" for industrials)
 */
export async function runEventStudy(
  ticker: string,
  eventDate: string,
  benchmark: string = "XLI",
): Promise<EventStudyResult | null> {
  // Fetch price data for both ticker and benchmark (2 years to cover T+180)
  const [tickerData, benchData] = await Promise.all([
    fetchPrices(ticker, "2y", "1d"),
    fetchPrices(benchmark, "2y", "1d"),
  ]);

  if (!tickerData.prices.length || !benchData.prices.length) return null;

  // Build date→index maps
  const tickerIndex = new Map<string, number>(
    tickerData.prices.map((p: PricePoint, i: number) => [p.date, i]),
  );
  const benchIndex = new Map<string, number>(
    benchData.prices.map((p: PricePoint, i: number) => [p.date, i]),
  );

  // Find the event date index (or nearest trading day after)
  let eventIdx = tickerIndex.get(eventDate);
  if (eventIdx === undefined) {
    // Find next trading day
    const sorted = tickerData.prices.map((p: PricePoint) => p.date).sort();
    const nextDay = sorted.find((d: string) => d >= eventDate);
    if (!nextDay) return null;
    const nextIdx = tickerIndex.get(nextDay);
    if (nextIdx === undefined) return null;
    eventIdx = nextIdx;
  }

  const result: EventStudyResult = {
    ticker,
    eventDate,
    benchmark,
    windows: {},
  };

  for (const days of WINDOWS) {
    const endIdx = eventIdx + days;
    if (endIdx >= tickerData.prices.length) continue;

    const startPrice = tickerData.prices[eventIdx].adjClose;
    const endPrice = tickerData.prices[endIdx].adjClose;
    const tickerReturn = (endPrice - startPrice) / startPrice;

    // Find matching benchmark dates
    const startDate = tickerData.prices[eventIdx].date;
    const endDate = tickerData.prices[endIdx].date;

    const benchStartIdx = benchIndex.get(startDate);
    const benchEndIdx = benchIndex.get(endDate);

    let benchmarkReturn = 0;
    if (benchStartIdx !== undefined && benchEndIdx !== undefined) {
      const bStart = benchData.prices[benchStartIdx].adjClose;
      const bEnd = benchData.prices[benchEndIdx].adjClose;
      benchmarkReturn = (bEnd - bStart) / bStart;
    }

    result.windows[`T+${days}`] = {
      days,
      tickerReturn,
      benchmarkReturn,
      excessReturn: tickerReturn - benchmarkReturn,
      startDate,
      endDate,
    };
  }

  return result;
}

/**
 * Run event studies for multiple events and aggregate by type.
 */
export async function aggregateEventStudy(
  events: Array<{ ticker: string; date: string; type: string }>,
  benchmark: string = "XLI",
  opts: { delayMs?: number } = {},
): Promise<AggregateResult[]> {
  const byType = new Map<string, EventStudyResult[]>();
  const delay = opts.delayMs ?? 300;

  for (const event of events) {
    const result = await runEventStudy(event.ticker, event.date, benchmark);
    if (result) {
      result.eventType = event.type;
      const arr = byType.get(event.type) || [];
      arr.push(result);
      byType.set(event.type, arr);
    }
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
  }

  const aggregates: AggregateResult[] = [];

  for (const [eventType, results] of byType) {
    const agg: AggregateResult = {
      eventType,
      count: results.length,
      windows: {},
    };

    for (const windowKey of WINDOWS.map(d => `T+${d}`)) {
      const values = results
        .map(r => r.windows[windowKey]?.excessReturn)
        .filter((v): v is number => v !== undefined);

      if (!values.length) continue;

      const sorted = [...values].sort((a, b) => a - b);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const median = sorted[Math.floor(sorted.length / 2)];
      const winRate = values.filter(v => v > 0).length / values.length;
      const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;

      agg.windows[windowKey] = {
        meanExcess: mean,
        medianExcess: median,
        winRate,
        stdDev: Math.sqrt(variance),
      };
    }

    aggregates.push(agg);
  }

  return aggregates;
}
