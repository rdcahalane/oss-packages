# Developer Utility Packages

Reusable TypeScript packages extracted and sanitized from production projects.

These packages are intended to solve common developer problems without shipping
private data, personal integrations, or company-specific infrastructure.

## Packages

| Package | Purpose |
|---|---|
| `channel-formatter` | Format and split AI-generated markdown for chat platforms |
| `pptx-extractor` | Extract slide text and structured fields from PowerPoint files |
| `hybrid-search-pgvector` | Combine pgvector similarity with PostgreSQL full-text search |
| `sharepoint-files` | Access, download, and extract text from SharePoint files via Microsoft Graph |
| `@rdcahalane/ai-router` | Route requests across LLM providers with fallback support |
| `@rdcahalane/edgar-client` | Query public SEC EDGAR data with a single client |
| `action-items` | Extract structured action items from meetings, transcripts, and documents |
| `output-quality` | Review, revise, and compress markdown documents for export workflows |
| `event-study-engine` | Measure excess returns around time-bound events |
| `agent-factory-discord` | Multi-agent Discord bot starter with debate and routing support |
| `market-data-lite` | Lightweight public market price fetcher used by `event-study-engine` |

## Live Packages

Published on npm:

- `channel-formatter`
- `pptx-extractor`
- `hybrid-search-pgvector`
- `sharepoint-files`
- `action-items`
- `@rdcahalane/ai-router`
- `@rdcahalane/edgar-client`
- `market-data-lite`
- `event-study-engine`
- `output-quality`
- `agent-factory-discord`

## Goals

- Keep runtime configuration external and environment-driven
- Avoid private endpoints, secrets, and hardcoded personal paths
- Preserve useful patterns while removing organization-specific assumptions

## Status

This repository has been sanitized, published, and verified locally with:

1. `npm install`
2. `npm run build`
3. `npm run typecheck`

The next useful improvements are CI, tests, examples, and per-package release automation.

## License

MIT
