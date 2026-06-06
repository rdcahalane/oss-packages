export type DiscordIntent =
  | "repair"
  | "publish"
  | "status"
  | "triage"
  | "investigate"
  | "summarize"
  | "retry"
  | "ask"
  | "board"
  | "debate"
  | "chat";

export function isImplicitRepairRequest(content: string): boolean {
  return /^(fix|repair|patch|resolve|unbreak|debug)(?:\s+it)?!?$/i.test(content.trim());
}

export function classifyDiscordIntent(content: string): DiscordIntent {
  const text = content.trim().toLowerCase();
  if (!text) return "chat";
  if (/^!board\b/i.test(text)) return "board";
  if (/^!debate\b/i.test(text)) return "debate";
  if (/^!ask\b/i.test(text)) return "ask";
  if (/^!retry\b/i.test(text)) return "retry";
  if (isImplicitRepairRequest(text) || /\b(fix|repair|patch|debug|unbreak|root cause|bug|broken|failure|incident|loop failure)\b/i.test(text)) return "repair";
  if (/\b(publish|post|share|announce|announcement|launch|release|draft|newsletter|linkedin|tweet|x post|discord post|slack post|email blast|send to channel|channel-ready|ready to post|publish-ready)\b/i.test(text)) return "publish";
  if (/\b(status|health|healthcheck|heartbeat|uptime|running|live|working|monitor|watch|observe|check|did it publish|did it send|did it fail|any failures|anything fails)\b/i.test(text)) return "status";
  if (/\b(triage|prioritize|sort|bucket|queue|dispatch|route|assign)\b/i.test(text)) return "triage";
  if (/\b(investigate|diagnose|trace|compare|difference|diff|why did|why is|why are|what failed|failure analysis|cause)\b/i.test(text)) return "investigate";
  if (/\b(summarize|digest|brief|recap|update|what changed|wrap up)\b/i.test(text)) return "summarize";
  return "chat";
}

export function buildIntentPrompt(content: string): string {
  const intent = classifyDiscordIntent(content);
  const trimmed = content.trim();
  if (intent === "repair") {
    return [
      "The user is asking for a repair or fix.",
      "Use the immediately preceding Discord context to identify the most important active failure, bug, regression, or broken workflow.",
      "Repair it directly if possible, or produce the smallest concrete fix plan if code changes are required.",
      "Do not ask for clarification unless there is truly no recoverable context.",
      "Prioritize recent failures, loop failures, and prime-directive / dispatch blind spots.",
    ].join(" ");
  }
  if (intent === "publish") {
    return [
      "The user wants help publishing, posting, or drafting something to a channel.",
      "Return a publish-ready artifact, including the exact message copy, recommended channel, and the smallest next step needed to send it.",
      "Optimize for clarity, brevity, and practical consumption.",
      `User request: ${trimmed}`,
    ].join(" ");
  }
  if (intent === "status") {
    return [
      "The user wants a status / health / did-it-work check.",
      "Return a concrete state report with any failures, missing deliveries, and the single most likely problem if something is not working.",
      `User request: ${trimmed}`,
    ].join(" ");
  }
  if (intent === "triage") {
    return [
      "The user wants prioritization or routing help.",
      "Return a ranked list with the smallest set of actionable next steps.",
      `User request: ${trimmed}`,
    ].join(" ");
  }
  if (intent === "investigate") {
    return [
      "The user wants an investigation.",
      "Trace the likely failure path, identify the most probable root cause, and state what to check next.",
      `User request: ${trimmed}`,
    ].join(" ");
  }
  if (intent === "summarize") {
    return [
      "The user wants a concise summary or digest.",
      "Summarize the important points and include explicit action items or outputs if relevant.",
      `User request: ${trimmed}`,
    ].join(" ");
  }
  return trimmed;
}
