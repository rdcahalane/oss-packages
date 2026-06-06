# @rdcahalane/ai-router

Simple multi-provider LLM router with fallback across local and hosted models.

## Features

- Routes prompts by task type
- Supports local Ollama fallback
- Handles provider errors and quota failures
- Supports text and image inputs

## Install

```bash
npm install @rdcahalane/ai-router
```

## Usage

```ts
import { createAIRouter } from "@rdcahalane/ai-router";

const router = createAIRouter({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  ollamaUrl: process.env.OLLAMA_URL,
});

const text = await router.chat({
  user: "Summarize this report",
  requireQuality: true,
});
```

## Notes

- Local-first setups can rely on Ollama for cheap fallback
- Host applications should decide their own provider policy and cost controls
- Best for apps that want one simple abstraction over several model providers
