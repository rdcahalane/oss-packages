# agent-factory-discord

Multi-agent Discord bot for routing prompts across local and cloud agents, with optional debate workflows and review steps.

This package is a good fit for teams that want one Discord interface over several model backends instead of binding themselves to a single provider.

## Features

- Auto-routing by task type
- Explicit agent selection with `!agent:` commands
- Debate mode with multiple agents
- Optional red-team review flow
- Support for local models, remote hosted models, CLI-based agents, and API-based agents

## Supported Agent Types

- local Ollama models
- remote HTTP-backed local models
- Claude-backed flows
- Codex-backed flows
- Gemini-backed flows

The package is designed so you can enable only the agents you actually use.

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
