# agent-factory-discord

Multi-agent Discord bot for routing prompts across local and cloud agents, with optional debate workflows and review steps.

This package is a good fit for teams that want one Discord interface over several model backends instead of binding themselves to a single provider.

## Features

- Auto-routing by task type
- Explicit agent selection with `!agent:` commands
- **Multi-model debate** (`!debate all`) across every configured backend — distinct models argue, not one model with itself
- **Resilient debates/boards** — an unavailable agent (auth error, offline, timeout) is skipped with a one-line note; one bad agent never aborts the session
- **Board of advisors** (`!board all`) — a full persona panel (CFO, CMO, CTO, COO, GC, CPO, UX, plus fun advisors), token-budget capped
- Optional red-team / Socratic review flow
- Support for local models, remote hosted models, CLI-based agents, and API-based agents

## Supported Agent Types

- local Ollama models (one or more nodes — e.g. a second box on your LAN/Tailscale for free model diversity)
- remote HTTP-backed local models (llama.cpp)
- Claude-backed flows (API)
- Codex-backed flows (OpenAI subscription)
- Gemini-backed flows (CLI)
- Kimi via OpenRouter (optional, paid) — adds a frontier model to debates

The package is designed so you can enable only the agents you actually use; any agent
you haven't configured is simply skipped at debate time.

## Example Commands

```text
What is X?
!claude: explain this stack trace
!local: summarize this README
!gemini: analyze this long PDF

!debate: should we ship this API design?
!debate claude vs local: compare these approaches
!debate claude vs local 3: evaluate this refactor plan
```

## Setup

1. Copy `.env.example` to `.env`
2. Create a Discord bot and add it to your server
3. Configure the agents you want to enable
4. Start the bot

```bash
cp .env.example .env
npm install
npm run dev
```

## Routing Model

The router is intended to favor cheap or local execution first for lightweight tasks, then escalate to stronger models for long documents, vision, or higher-context work.

## Environment

Common settings include:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_TASK_CHANNEL_ID`
- `AGENT_ROUTER_ENABLED`
- `OLLAMA_URL`
- `GEMINI_API_KEY`

Some optional settings in `.env.example` refer to a remote model endpoint under the label `BEAST_*`. You can treat that as a generic remote local-model service and rename those environment variables in your own deployment if you prefer.

## Notes

- This package assumes Discord as the interaction surface
- It is best used as an app starter or template rather than a drop-in library
- You should review agent permissions carefully before enabling execution-oriented flows
