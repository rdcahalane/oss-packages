# action-items

Extract structured action items from transcripts, documents, and message threads.

## Features

- returns typed JSON
- captures assignee, due date, priority, and source context
- optimized for messy human text rather than idealized inputs

## Install

```bash
npm install action-items
```

## Usage

```ts
import { createActionItemExtractor } from "action-items";

const extract = createActionItemExtractor({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
});

const items = await extract({
  title: "Weekly Ops Review",
  content: transcript,
});
```

Good for meeting bots, task capture workflows, and document triage tools.
