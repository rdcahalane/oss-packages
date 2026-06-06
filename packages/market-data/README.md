# market-data-lite

Lightweight helpers for fetching public Yahoo Finance price history.

## Features

- historical price retrieval
- latest price lookup
- batch fetching with courtesy delays
- normalized OHLCV output

## Install

```bash
npm install market-data-lite
```

## Usage

```ts
import { fetchPrices, latestPrice, fetchPricesBatch } from "market-data-lite";

const history = await fetchPrices("AAPL", "1y", "1d");
const latest = await latestPrice("AAPL");
const batch = await fetchPricesBatch(["AAPL", "MSFT", "NVDA"]);
```

## Notes

- Uses a public Yahoo Finance endpoint
- Best for prototypes, backtests, and internal tools
- Production use should account for endpoint reliability and terms of use
