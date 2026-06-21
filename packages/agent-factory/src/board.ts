import type { AgentTask } from "./coordinator.js";
import { pickAdvisors, type Advisor } from "./advisors.js";
import { withFallback } from "./agents/fallback.js";
import { recordDebateLesson } from "./discord-memory.js";

interface AdvisorResponse {
  advisor: Advisor;
  content: string;
}

async function getAgent(name: string) {
  switch (name) {
    case "beast": { const { execute: b } = await import("./agents/beast.js"); return (t: AgentTask) => withFallback(b, "claude", t); }
    case "gemini": return (await import("./agents/gemini-cli.js")).execute;
    case "local":  return (await import("./agents/local.js")).execute;
    case "canoe":  return (await import("./agents/canoe.js")).execute;
    case "kimi":   return (await import("./agents/kimi.js")).execute;
    case "codex":
    case "openai": return (await import("./agents/codex-cli.js")).execute;
    case "claude":
    default:       return (await import("./agents/claude-cli.js")).execute;
  }
}

function buildCriticPrompt(topic: string, responses: AdvisorResponse[]): string {
  const transcript = responses
    .map(r => `[${r.advisor.name.toUpperCase()}]\n${r.content}`)
    .join("\n\n---\n\n");

  return (
    `You are a strict adversarial critic. Your ONLY job is to find the 2-3 most significant flaws, ` +
    `gaps, or unsupported assumptions in the following board responses. ` +
    `Be specific and direct — name the exact claim that is weakest and why. ` +
    `Do not balance your critique with positives.\n\n` +
    `Topic: "${topic}"\n\n` +
    `Board responses:\n\n${transcript}`
  );
}

function buildBoardSynthesis(topic: string, responses: AdvisorResponse[], criticOutput: string): string {
  const transcript = responses
    .map(r => `[${r.advisor.name.toUpperCase()}]\n${r.content}`)
    .join("\n\n---\n\n");

  const names = responses.map(r => r.advisor.name).join(", ");

  return (
    `You are a neutral synthesizer applying causal reasoning. ` +
    `A board of advisors (${names}) just weighed in on: "${topic}"\n\n` +
    `Transcript:\n\n${transcript}\n\n` +
    `---\n\n[ADVERSARIAL CRITIC]\n${criticOutput}\n\n---\n\n` +
    `Synthesize using this structure:\n` +
    `1. POINTS OF AGREEMENT — where did multiple advisors converge? Treat this as strong signal.\n` +
    `2. KEY TENSIONS — where did perspectives conflict? Name the tradeoff explicitly.\n` +
    `3. CRITIC CHALLENGES — where did the adversarial review find the weakest points?\n` +
    `4. BLIND SPOTS — what did no advisor address that matters?\n` +
    `5. VERDICT — what is the most defensible position given all inputs? Take a position.\n\n` +
    `Socratic requirements:\n` +
    `- Make the key assumption explicit.\n` +
    `- Name the smallest missing evidence that would improve the decision.\n` +
    `- If the board is already sufficiently decisive, keep the friction minimal.\n\n` +
    `End with exactly these two lines:\n` +
    `PROPOSED ACTION: [one concrete sentence — what should be done next]\n` +
    `PROVOCATION: [one question targeting the weakest assumption — if answered, the verdict should update]`
  );
}

/** Returns the plan (advisors + estimated time) without running the board. */
export function planBoard(
  topic: string,
  rawIds?: string[],
  rosterCtx?: string,
): { advisors: { id: string; name: string; domain: string }[]; estimatedTime: string } {
  const advisors = pickAdvisors(topic, rawIds, 4, rosterCtx ?? "global");

  function angleFor(advisor: Advisor): string {
    const lower = topic.toLowerCase();
    const topKw = advisor.keywords
      .filter(kw => lower.includes(kw))
      .slice(0, 2)
      .join(", ");
    if (topKw) return `${topKw} angle`;
    const careMatch = advisor.persona.match(/You care about ([^.]+)\./i);
    if (careMatch) return careMatch[1].replace(/\s+/g, " ").trim().slice(0, 60);
    return advisor.name.toLowerCase() + " perspective";
  }

  const advisorList = advisors.map(a => ({
    id: a.id,
    name: a.name,
    domain: angleFor(a),
  }));

  // ~60s per advisor + 30s critic + 60s synthesis
  const totalSec = advisors.length * 60 + 30 + 60;
  const estimatedTime = `~${Math.ceil(totalSec / 60)} min`;

  return { advisors: advisorList, estimatedTime };
}

export async function runBoard(
  task: AgentTask,
  onAdvisor: (task: AgentTask, advisorId: string, idx: number, content: string) => void,
): Promise<string> {
  const { prompt: topic, advisor_ids: rawIds, _roster_ctx: rosterCtx } = task.payload as {
    prompt: string;
    advisor_ids?: string[];
    _roster_ctx?: string;
  };

  const advisors = pickAdvisors(topic, rawIds, 4, rosterCtx ?? "global");

  if (advisors.length === 0) {
    return "No active advisors matched this topic. Use `!invite advisorId` to add advisors back, or `!board cfo cmo: topic` to force specific ones.";
  }

  const context = task.payload.context ?? "";
  const contextPrefix = context ? `Background context: ${context}\n\n` : "";
  const responses: AdvisorResponse[] = [];

  // Token budget guard — stop calling advisors at 80% of budget to preserve room for critic+synthesis
  const TOKEN_BUDGET = parseInt(process.env.BOARD_TOKEN_BUDGET ?? "12000", 10);
  let estimatedTokensUsed = 0;
  let budgetExceeded = false;

  for (let i = 0; i < advisors.length; i++) {
    if (budgetExceeded) break;
    const advisor = advisors[i];
    const advisorPrompt = `${contextPrefix}${advisor.persona}\n\nTopic for your input: "${topic}"`;
    const advisorTask: AgentTask = {
      ...task,
      payload: { prompt: advisorPrompt, max_tokens: 600 },
    };
    const execute = await getAgent(advisor.agent ?? "claude");
    let content: string;
    try {
      content = await execute(advisorTask);
    } catch (e: any) {
      // An unavailable agent (auth error, ENOENT, timeout) must NOT kill the board —
      // skip this advisor and move to the next one.
      console.warn(`[board] advisor ${advisor.id} (${advisor.agent}) unavailable — skipping: ${e?.message ?? e}`);
      onAdvisor(task, advisor.id, i + 1, `⚠️ ${advisor.name} is unavailable — skipped (${String(e?.message ?? e).slice(0, 100)}).`);
      continue;
    }
    responses.push({ advisor, content });
    onAdvisor(task, advisor.id, i + 1, content);

    estimatedTokensUsed += Math.ceil((advisorPrompt.length + content.length) / 4);
    if (estimatedTokensUsed > TOKEN_BUDGET * 0.8 && i < advisors.length - 1) {
      budgetExceeded = true;
    }
  }

  // Adversarial critic pass — finds the 2-3 weakest claims before synthesis
  const criticTask: AgentTask = {
    ...task,
    payload: { prompt: buildCriticPrompt(topic, responses), max_tokens: 400 },
  };
  if (responses.length === 0) {
    return "All advisors were unavailable — the board could not run. Check agent auth/availability (e.g. GEMINI_API_KEY).";
  }

  const criticAgent = await getAgent("claude");
  let criticOutput: string;
  try { criticOutput = await criticAgent(criticTask); }
  catch (e: any) { console.warn(`[board] critic unavailable: ${e?.message ?? e}`); criticOutput = "_(critic pass unavailable)_"; }

  // Synthesis — incorporates critic output in 5-section structure
  const synthTask: AgentTask = {
    ...task,
    payload: { prompt: buildBoardSynthesis(topic, responses, criticOutput), max_tokens: 900 },
  };
  const synthesizer = await getAgent("claude");
  let synthesis: string;
  try { synthesis = await synthesizer(synthTask); }
  catch (e: any) { console.warn(`[board] synthesis unavailable: ${e?.message ?? e}`); synthesis = "_(synthesis unavailable — synthesizer agent failed)_"; }
  const proposedAction = extractProposedAction(synthesis);
  const provocation = extractProvocation(synthesis);
  void recordDebateLesson(topic, synthesis, proposedAction, provocation).catch(() => {});

  const transcript = responses
    .map(r => `**[${r.advisor.name.toUpperCase()}]**\n${r.content}`)
    .join("\n\n");

  const budgetNote = budgetExceeded
    ? `\n\n⚠️ Token budget reached — synthesizing from ${responses.length} of ${advisors.length} advisors.`
    : "";

  return `${transcript}${budgetNote}\n\n**[CRITIC]**\n${criticOutput}\n\n**[BOARD SYNTHESIS]**\n${synthesis}`;
}

export function extractProposedAction(text: string): string | null {
  const match = text.match(/PROPOSED ACTION:\s*(.+?)(?:\n|$)/i);
  return match?.[1]?.trim() ?? null;
}

export function extractProvocation(text: string): string | null {
  const match = text.match(/PROVOCATION:\s*(.+?)(?:\n|$)/i);
  return match?.[1]?.trim() ?? null;
}
