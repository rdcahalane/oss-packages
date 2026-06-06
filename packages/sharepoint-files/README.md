# sharepoint-files

Minimal Microsoft Graph client for SharePoint file access and text extraction.

## Features

- Client-credentials authentication
- Site and drive discovery
- Folder traversal and file listing
- File download helpers
- Plain-text extraction from common Office files

## Install

```bash
npm install sharepoint-files
```

## Usage

```ts
import { createSharePointClient } from "sharepoint-files";

const client = createSharePointClient({
  tenantId: process.env.MICROSOFT_TENANT_ID!,
  clientId: process.env.MICROSOFT_CLIENT_ID!,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
});

const site = await client.getSite("contoso.sharepoint.com:/sites/Research");
const drives = await client.listDrives(site.id);
```

## Notes

- Uses the Graph API directly
- Designed for service-to-service use
- Secrets must be provided via environment variables or host config

Good fit for ingestion jobs, knowledge sync tools, and internal search systems.
