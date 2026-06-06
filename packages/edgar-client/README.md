# edgar-client

Unified client for public SEC EDGAR data.

## Features

- ticker-to-CIK lookup
- full-text filing search
- XBRL financial series access
- Form 4 insider transaction parsing
- 8-K event parsing

## Install

```bash
npm install edgar-client
```

## Usage

```ts
import { lookupCIK, searchFilings, fetchFinancials } from "edgar-client";

const cik = await lookupCIK("AAPL");
const filings = await searchFilings({ ticker: "AAPL", form: "8-K" });
const revenue = await fetchFinancials("AAPL", "RevenueFromContractWithCustomerExcludingAssessedTax");
```

## Notes

- No API key required
- Includes courtesy delays for SEC-friendly usage
- You should set a real contact address in the User-Agent before production use

Good for finance tools, public-company research, and filing ingestion pipelines.
