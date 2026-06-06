/**
 * Form 4 Insider Transaction Parser
 *
 * Extracts officer/director names and trade details from SEC Form 4 filings.
 * Useful for ownership tracking, officer lookup, and insider-trading analysis workflows.
 */

import { edgarFetch, RATE_LIMIT_MS } from "./index.js";
import { lookupCIK } from "./cik.js";

export interface Form4Person {
  name: string;
  title: string;
  isOfficer: boolean;
  isDirector: boolean;
  is10PctOwner: boolean;
  ticker: string;
  cik: number;
  /** Transactions (buys/sells) if available */
  transactions?: Array<{
    date: string;
    code: string;  // P=purchase, S=sale, A=award, etc.
    shares: number;
    pricePerShare: number;
    sharesOwned: number;
  }>;
  accessionNo: string;
  filingDate: string;
}

/**
 * Fetch Form 4 filers for a ticker.
 *
 * Returns officer/director names with their insider transactions.
 */
export async function fetchForm4People(
  ticker: string,
  opts: { limit?: number } = {}
): Promise<Form4Person[]> {
  const cik = await lookupCIK(ticker);
  if (!cik) return [];

  const cikPadded = String(cik).padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;

  const r = await edgarFetch(url);
  if (!r.ok) return [];

  const data = await r.json() as {
    filings: {
      recent: {
        accessionNumber: string[];
        form: string[];
        filingDate: string[];
        primaryDocument: string[];
      };
    };
  };

  const recent = data?.filings?.recent;
  if (!recent) return [];

  // Find Form 4 filings
  const form4Indices: number[] = [];
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === "4" || recent.form[i] === "4/A") {
      form4Indices.push(i);
    }
  }

  const limit = opts.limit ?? 20;
  const people: Form4Person[] = [];
  const seen = new Set<string>();

  for (const idx of form4Indices.slice(0, limit * 2)) {
    const accNo = recent.accessionNumber[idx];
    const filingDate = recent.filingDate[idx];
    const docName = recent.primaryDocument[idx];

    if (!accNo || !docName) continue;

    // Fetch the Form 4 XML
    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo.replace(/-/g, "")}/${docName}`;

    try {
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      const xmlR = await edgarFetch(xmlUrl, {
        headers: { Accept: "application/xml,text/xml,text/html" } as Record<string, string>,
      });
      if (!xmlR.ok) continue;

      const xmlText = await xmlR.text();

      // Extract reporter name
      const nameMatch = xmlText.match(/<rptOwnerName>([^<]+)/);
      const titleMatch = xmlText.match(/<officerTitle>([^<]+)/);
      const isOfficer = /<isOfficer>true/i.test(xmlText) || /<isOfficer>1/.test(xmlText);
      const isDirector = /<isDirector>true/i.test(xmlText) || /<isDirector>1/.test(xmlText);
      const is10Pct = /<isTenPercentOwner>true/i.test(xmlText) || /<isTenPercentOwner>1/.test(xmlText);

      if (!nameMatch) continue;

      const rawName = nameMatch[1].trim();
      const key = rawName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Extract transactions
      const transactions: Form4Person["transactions"] = [];
      const txMatches = xmlText.matchAll(
        /<transactionDate>.*?<value>([^<]+).*?<transactionCoding>.*?<transactionCode>([^<]+).*?<transactionAmounts>.*?<transactionShares>.*?<value>([^<]+).*?<transactionPricePerShare>.*?<value>([^<]*)/gs
      );
      for (const tx of txMatches) {
        transactions.push({
          date: tx[1]?.trim() || filingDate,
          code: tx[2]?.trim() || "?",
          shares: parseFloat(tx[3]?.trim() || "0"),
          pricePerShare: parseFloat(tx[4]?.trim() || "0"),
          sharesOwned: 0,
        });
      }

      people.push({
        name: rawName,
        title: titleMatch?.[1]?.trim() || (isDirector ? "Director" : "Officer"),
        isOfficer,
        isDirector,
        is10PctOwner: is10Pct,
        ticker: ticker.toUpperCase(),
        cik,
        transactions: transactions.length ? transactions : undefined,
        accessionNo: accNo,
        filingDate,
      });

      if (people.length >= limit) break;
    } catch {
      continue;
    }
  }

  return people;
}
