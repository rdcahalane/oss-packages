# hybrid-search-pgvector

Hybrid semantic and keyword search for Postgres with `pgvector`.

## Features

- Combines vector similarity and full-text search
- Uses Reciprocal Rank Fusion
- Supports metadata and tag filters
- Includes a simple upsert helper

## Install

```bash
npm install hybrid-search-pgvector pg
```

## Usage

```ts
import { createHybridSearch } from "hybrid-search-pgvector";

const search = createHybridSearch({
  pool,
  embedFn: (text) => embed(text),
  table: "documents",
});

const results = await search.search({
  query: "manufacturing automation roadmap",
  limit: 10,
});
```

## Requirements

- PostgreSQL
- `pgvector`
- a table with text, vector, metadata, and timestamp fields

Best for AI memory stores, document search, and retrieval-augmented applications.
