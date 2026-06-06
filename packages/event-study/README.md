# event-study-engine

Run simple event studies against a benchmark ETF using public market data.

## Features

- standard T+1, T+5, T+10, T+30, T+90, and T+180 windows
- excess-return calculation versus a benchmark
- aggregation by event type
- lightweight dependency model

## Install

```bash
npm install event-study-engine
```

## Usage

```ts
import { runEventStudy, aggregateEventStudy } from "event-study-engine";

const single = await runEventStudy("HON", "2026-01-15", "XLI");

const aggregates = await aggregateEventStudy([
  { ticker: "HON", date: "2026-01-15", type: "earnings" },
  { ticker: "ROK", date: "2026-02-10", type: "guidance" },
]);
```

## Notes

- Uses `market-data-lite` for public price history
- Intended for lightweight analysis, prototypes, and research tooling
- Not investment advice
