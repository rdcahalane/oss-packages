// Returns true when the question likely requires live/current data that an LLM can't know
export function needsWebSearch(content: string): boolean {
  const t = content.trim().toLowerCase();

  // Explicit live-data keywords
  if (/\b(latest|current|right now|as of today|this week|this month|today'?s?|tonight'?s?|yesterday'?s?|breaking|live|real-time|real time)\b/.test(t)) return true;

  // News / events
  if (/\b(news|headlines|what('?s| is) happening|what happened|any updates?|did .+ (happen|win|lose|pass|fail|launch|release|announce))\b/.test(t)) return true;

  // Price / market / weather
  if (/\b(price of|stock price|trading at|market cap|weather|forecast|temperature|score of|game score|standings|rankings)\b/.test(t)) return true;

  // "Is X still..." / "Does X still..."
  if (/\b(is .+ still|does .+ still|are .+ still|has .+ (been|changed|updated|released|launched))\b/.test(t)) return true;

  // Specific lookup-style questions where freshness matters
  if (/\b(who (won|is winning|leads?|is (ceo|president|cto|cfo)|runs?)|when (did|does|is|will) .+ (release|launch|open|close|start|end))\b/.test(t)) return true;

  return false;
}

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
  const looksLikeQuestion = /[?]\s*$/.test(trimmed) || /^(what|why|how|which|who|where|when|is it|are we|should we|can we|does this|do you think|opinion on)\b/i.test(trimmed);
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
  if (/https?:\/\/\S+/i.test(trimmed) || /linkedin\.com/i.test(trimmed)) {
    return [
      "The user shared a link or social post and wants a useful response.",
      "Analyze the content, give a clear take, identify what matters, and suggest the best next move.",
      "If the post is noteworthy, say why and whether it deserves reply, repost, or follow-up.",
      `User request: ${trimmed}`,
    ].join(" ");
  }
  if (looksLikeQuestion) {
    const isSimpleFact = /^(what('?s| is) (the )?(time|date|day|year|month)|how (old|long|many|much)|who (is|are|was|were)|where (is|are)|when (is|was|did))\b/i.test(trimmed);
    if (isSimpleFact) {
      return trimmed;
    }
    return [
      "The user is asking a direct question and wants an actual answer, not observation.",
      "Answer directly and decisively in plain language.",
      "Be specific: name the concrete gap, what is likely causing it, and what to do next.",
      "If the user compares something to 'our setup', compare it against the current bot / route / prompt / retry flow rather than giving generic NLP advice.",
      "Do not say 'improve conversational flow', 'add NLP', or 'research frameworks' unless that is the actual best next action.",
      `User request: ${trimmed}`,
    ].join(" ");
  }
  return trimmed;
}
