# channel-formatter

Format markdown-like AI output for messaging channels with different syntax and size limits.

## Features

- Telegram MarkdownV2 escaping
- Slack-friendly markdown conversion
- Plain-text SMS fallback
- Message chunking by channel size limits

## Install

```bash
npm install channel-formatter
```

## Usage

```ts
import { formatForChannel } from "channel-formatter";

const chunks = formatForChannel(markdown, "telegram");

for (const chunk of chunks) {
  await sendMessage(chunk);
}
```

## Supported Channels

- `telegram`
- `slack`
- `teams`
- `sms`

## Exports

- `formatForChannel(text, channel)`
- `splitMessage(text, maxLen)`

Best for notification bots, chat assistants, and workflow tools that need channel-specific output formatting.
