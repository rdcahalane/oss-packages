/**
 * market-data-lite
 *
 * Lightweight public market price fetching.
 * Uses free public Yahoo Finance endpoints for historical data.
 */

export interface PricePoint {
  date: string;       // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
}

export interface QuoteResult {
  ticker: string;
  currency: string;
  prices: PricePoint[];
  error?: string;
}

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

/**
 * Fetch historical prices for a ticker.
 *
 * @param ticker - Stock ticker (e.g. "AAPL", "HON")
 * @param range - Time range: "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"
 * @param interval - Data interval: "1d", "1wk", "1mo"
 */
export async function fetchPrices(
  ticker: string,
  range: string = "1y",
  interval: string = "1d",
): Promise<QuoteResult> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includeAdjustedClose=true`;

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; market-data-lite/0.1.0)",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) {
      return { ticker, currency: "USD", prices: [], error: `HTTP ${r.status}` };
    }

    const data = await r.json() as {
      chart: {
        result: Array<{
          meta: { currency: string };
          timestamp: number[];
          indicators: {
            quote: Array<{
              open: number[]; high: number[]; low: number[]; close: number[]; volume: number[];
            }>;
            adjclose?: Array<{ adjclose: number[] }>;
          };
        }>;
        error?: { description: string };
      };
    };

    if (data.chart.error) {
      return { ticker, currency: "USD", prices: [], error: data.chart.error.description };
    }

    const result = data.chart.result?.[0];
    if (!result?.timestamp) {
      return { ticker, currency: "USD", prices: [], error: "No data" };
    }

    const q = result.indicators.quote[0];
    const adj = result.indicators.adjclose?.[0]?.adjclose;

    const prices: PricePoint[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const close = q.close[i];
      if (close == null || isNaN(close)) continue;

      prices.push({
        date: new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10),
        open: q.open[i] ?? close,
        high: q.high[i] ?? close,
        low: q.low[i] ?? close,
        close,
        adjClose: adj?.[i] ?? close,
        volume: q.volume[i] ?? 0,
      });
    }

    return { ticker, currency: result.meta.currency ?? "USD", prices };
  } catch (e) {
    return { ticker, currency: "USD", prices: [], error: String(e) };
  }
}

/**
 * Get the latest price for a ticker.
 */
export async function latestPrice(ticker: string): Promise<{ price: number; change: number; changePct: number } | null> {
  const result = await fetchPrices(ticker, "5d", "1d");
  if (!result.prices.length) return null;

  const latest = result.prices[result.prices.length - 1];
  const prev = result.prices.length > 1 ? result.prices[result.prices.length - 2] : latest;

  return {
    price: latest.close,
    change: latest.close - prev.close,
    changePct: prev.close ? ((latest.close - prev.close) / prev.close) * 100 : 0,
  };
}

/**
 * Batch fetch prices for multiple tickers with courtesy delays.
 */
export async function fetchPricesBatch(
  tickers: string[],
  range: string = "1y",
  opts: { delayMs?: number } = {},
): Promise<Map<string, QuoteResult>> {
  const results = new Map<string, QuoteResult>();
  const delay = opts.delayMs ?? 200;

  for (const ticker of tickers) {
    results.set(ticker, await fetchPrices(ticker, range));
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
  }

  return results;
}
