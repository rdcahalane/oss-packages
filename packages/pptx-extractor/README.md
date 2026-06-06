# pptx-extractor

Extract raw text and structured fields from PowerPoint `.pptx` files.

## Features

- Reads slide text directly from the PPTX archive
- Returns per-slide text and text runs
- Supports caller-defined field extractors
- Works in Node.js and other ArrayBuffer-capable runtimes

## Install

```bash
npm install pptx-extractor
```

## Usage

```ts
import { extractSlides, parseSlideFields } from "pptx-extractor";

const slides = extractSlides(arrayBuffer);

const fields = parseSlideFields(slides[0].slideText, slides[0].textParts, {
  questionId: { pattern: /\b(Q\d+)\b/, group: 1 },
  headline: { strategy: "longest-insight" },
});
```

## Main Exports

- `extractSlides(buffer)`
- `parseSlideFields(slideText, textParts, extractors)`
- `extractAndParse(buffer, extractors, options?)`
- `SURVEY_DECK_EXTRACTORS`

Useful for document pipelines, research ingestion, and slide-analysis tools.
