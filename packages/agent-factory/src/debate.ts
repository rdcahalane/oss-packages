import type { AgentTask } from "./coordinator.js";
import { getAdvisorById, isAdvisorId } from "./advisors.js";
import { withFallback } from "./agents/fallback.js";
import { recordDebateLesson } from "./discord-memory.js";

export type AgentName = "claude" | "codex" | "gemini" | "local" | "beast" | "openai" | string;

interface Round {
  agent: AgentName;
  round: number;
  content: string;
}

// Condensed Causal Kernel — injected for the Socratic agent role
const CAUSAL_KERNEL = `
APPLY CAUSAL REASONING to your response:
1. Hypothesis first — state the specific claim before any evidence
2. Falsification — what evidence would prove this wrong? If you can't state one, it's description not diagnosis
3. Mechanism — how does X cause Y? Explicitly flag if it's correlation not causation
4. Counterfactual — what changes if the key cause is removed?
5. End with ONE provocation question targeting the weakest assumption in this debate — phrased so that if someone answers it, the diagnosis should update

Rule: data without a reasoning frame is a dashboard. Data organized by a reasoning frame is a diagnosis.
`.trim();

async function getAgentExecutor(name: AgentName) {
  // If name is an advisor ID, use the advisor's preferred agent (default: claude)
  if (isAdvisorId(name)) {
    const advisor = getAdvisorById(name)!;
    return getAgentExecutor(advisor.agent ?? "claude");
  }
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

function advisorLabel(name: AgentName): string {
  if (isAdvisorId(name)) {
    return getAdvisorById(name)?.name ?? name.toUpperCase();
  }
  return name.toUpperCase();
}

function advisorPersonaPrefix(name: AgentName): string {
  if (isAdvisorId(name)) {
    const advisor = getAdvisorById(name)!;
    return `${advisor.persona}\n\n`;
  }
  return "";
}

function buildRoundPrompt(
  topic: string,
  history: Round[],
  currentAgent: AgentName,
  isRedTeam: boolean,
  isSocratic: boolean,
): string {
  const transcript = history.map(r =>
    `[${advisorLabel(r.agent)} — Round ${r.round}]\n${r.content}`
  ).join("\n\n---\n\n");

  const label = advisorLabel(currentAgent);
  const personaPrefix = advisorPersonaPrefix(currentAgent);

  let instruction: string;
  if (isRedTeam && isSocratic) {
    instruction =
      `${personaPrefix}You are ${label} playing RED TEAM + SOCRATIC EXAMINER. ` +
      `Adversarially attack the dominant view AND probe the reasoning structure: ` +
      `demand a falsifiable hypothesis, expose correlation-as-causation, find the hidden assumption ` +
      `that collapses the argument. Do NOT be balanced — stress-test both the position and the logic. ` +
      `2-3 paragraphs max.\n\n${CAUSAL_KERNEL}`;
  } else if (isRedTeam) {
    instruction =
      `${personaPrefix}You are ${label} playing RED TEAM. Your job is adversarial: ` +
      `attack the dominant view, expose hidden assumptions, find the worst-case scenario, ` +
      `and refuse easy consensus. Steelman the strongest objection. Do NOT be balanced — ` +
      `stress-test the emerging position. 2-3 paragraphs max.`;
  } else if (isSocratic) {
    instruction =
      `${personaPrefix}You are ${label} playing SOCRATIC EXAMINER. Don't argue a side — ` +
      `interrogate the reasoning of every position so far. Demand falsifiable hypotheses. ` +
      `Expose correlation-as-causation. Force the other agents to separate mechanism from description. ` +
      `2-3 paragraphs max.\n\n${CAUSAL_KERNEL}`;
  } else {
    instruction =
      `${personaPrefix}You are ${label}. Respond to the most recent arguments from your perspective: ` +
      `challenge weak points, concede strong ones, and sharpen your position. Be concise (2-3 paragraphs max).`;
  }

  return `You are in a structured debate with multiple participants. Topic: "${topic}"\n\n` +
    `Debate so far:\n\n${transcript}\n\n---\n\n${instruction}`;
}

function buildSynthesisPrompt(
  topic: string,
  history: Round[],
  agents: AgentName[],
  redTeam: AgentName,
  socraticAgent?: AgentName,
): string {
  const transcript = history.map(r =>
    `[${advisorLabel(r.agent)} — Round ${r.round}]\n${r.content}`
  ).join("\n\n---\n\n");

  const names = agents.map(advisorLabel).join(", ");
  const roleNotes = [
    `${advisorLabel(redTeam)} played Red Team — their arguments were intentionally adversarial.`,
    socraticAgent
      ? `${advisorLabel(socraticAgent)} played Socratic Examiner — they probed reasoning structure, not just position.`
      : null,
  ].filter(Boolean).join("\n");

  return `You are a neutral synthesizer applying causal reasoning. ` +
    `A structured debate just concluded between ${names} on: "${topic}"\n\n` +
    `${roleNotes}\n\nTranscript:\n\n${transcript}\n\n---\n\n` +
    `Synthesize using this structure:\n` +
    `1. HYPOTHESIS — what is the most defensible causal claim from this debate?\n` +
    `2. FALSIFICATION — what evidence would disprove the winning position?\n` +
    `3. MECHANISM — is the dominant argument causal or merely correlational? Call out any correlation-as-causation errors.\n` +
    `4. COUNTERFACTUAL — what changes if the key cause is removed?\n` +
    `5. VERDICT — confirm / partially support / falsify the debate's main hypothesis. Take a position.\n\n` +
    `Socratic requirements:\n` +
    `- Surface the single weakest assumption that still needs evidence.\n` +
    `- If the answer is already good enough, say so and avoid extra questioning.\n` +
    `- If the recommendation is still weak, ask exactly one question that would materially change it.\n\n` +
    `Call out which Red Team objections were valid vs. weak. ` +
    `Where agents agreed under adversarial pressure, treat that as strong signal.\n\n` +
    `End with exactly these two lines:\n` +
    `PROPOSED ACTION: [one concrete sentence — what should be done next]\n` +
    `PROVOCATION: [one question targeting the weakest assumption — if answered, the verdict should update]`;
}

export function extractProposedAction(synthesis: string): string | null {
  const match = synthesis.match(/PROPOSED ACTION:\s*(.+?)(?:\n|$)/i);
  return match?.[1]?.trim() ?? null;
}

export function extractProvocation(synthesis: string): string | null {
  const match = synthesis.match(/PROVOCATION:\s*(.+?)(?:\n|$)/i);
  return match?.[1]?.trim() ?? null;
}

export async function runDebate(
  task: AgentTask,
  onRound: (task: AgentTask, agent: AgentName, roundNum: number, content: string) => void
): Promise<string> {
  const {
    prompt: topic,
    agents: rawAgents,
    rounds: rawRounds,
    red_team: rawRedTeam,
    socratic: rawSocratic,
  } = task.payload as { prompt: string; agents?: string[]; rounds?: number; red_team?: string; socratic?: string };

  const agents: AgentName[] = rawAgents?.length
    ? rawAgents.map(a => a as AgentName)
    : ["claude", "local"];

  const redTeam: AgentName = (rawRedTeam as AgentName) ?? agents[1];
  // Default: Red Team also plays Socratic unless an explicit --socratic agent is named
  const socraticAgent: AgentName | undefined = rawSocratic
    ? (rawSocratic as AgentName)
    : undefined;
  const defaultSocraticToRedTeam = !socraticAgent;

  const cycles = Math.min(Math.max(rawRounds ?? (agents.length > 2 ? 1 : 2), 1), 3);
  const totalRounds = agents.length * cycles;

  const context = task.payload.context ?? "";
  const contextPrefix = context ? `Background context: ${context}\n\n` : "";
  const history: Round[] = [];

  // Opening — first agent
  const openingTask: AgentTask = {
    ...task,
    payload: {
      prompt: `${contextPrefix}You are in a structured debate. Topic: "${topic}"\n\nState your opening position clearly. 2-3 paragraphs max.`,
      max_tokens: 600,
    },
  };
  // Per-advisor resilience: an unavailable agent (auth error, ENOENT, timeout)
  // must skip to the next debater, never abort the whole debate. Each agent's
  // first failure posts one compact "unavailable — skipped" note, then it's
  // dropped from the rest of the run.
  const failed = new Set<AgentName>();
  const tryExec = async (agent: AgentName, t: AgentTask, round: number): Promise<string | null> => {
    try {
      const exec = await getAgentExecutor(agent);
      return await exec(t);
    } catch (e: any) {
      if (!failed.has(agent)) {
        failed.add(agent);
        console.warn(`[debate] ${agent} unavailable — skipping: ${e?.message ?? e}`);
        onRound(task, agent, round, `⚠️ ${advisorLabel(agent)} is unavailable — skipped (${String(e?.message ?? e).slice(0, 100)}).`);
      }
      return null;
    }
  };

  // Opening — first agent that actually responds
  let opening: string | null = null;
  let openingAgent: AgentName | null = null;
  for (const a of agents) {
    opening = await tryExec(a, openingTask, 1);
    if (opening) { openingAgent = a; break; }
  }
  if (!opening || !openingAgent) {
    return "All advisors were unavailable — no debate could run. Check agent auth/availability (e.g. GEMINI_API_KEY).";
  }
  history.push({ agent: openingAgent, round: 1, content: opening });
  onRound(task, openingAgent, 1, opening);

  // Round-robin — skip any agent already known to be down
  for (let r = 2; r <= totalRounds; r++) {
    const current = agents[r % agents.length];
    if (failed.has(current)) continue;
    const isRed = current === redTeam;
    const isSoc = socraticAgent ? current === socraticAgent : (defaultSocraticToRedTeam && isRed);
    const roundTask: AgentTask = {
      ...task,
      payload: {
        prompt: contextPrefix + buildRoundPrompt(topic, history, current, isRed, isSoc),
        max_tokens: 700,
      },
    };
    const response = await tryExec(current, roundTask, r);
    if (!response) continue;
    history.push({ agent: current, round: r, content: response });
    onRound(task, current, r, response);
  }

  // Synthesis — prefer claude, fall back to any available agent
  const synthTask: AgentTask = {
    ...task,
    payload: {
      prompt: buildSynthesisPrompt(topic, history, agents, redTeam, socraticAgent),
      max_tokens: 900,
    },
  };
  let synthesis: string | null = await tryExec("claude", synthTask, totalRounds + 1);
  if (!synthesis) {
    for (const a of agents) {
      if (a === "claude") continue;
      synthesis = await tryExec(a, synthTask, totalRounds + 1);
      if (synthesis) break;
    }
  }
  if (!synthesis) synthesis = "_(synthesis unavailable — all synthesizer agents failed)_";
  const proposedAction = extractProposedAction(synthesis);
  const provocation = extractProvocation(synthesis);
  void recordDebateLesson(topic, synthesis, proposedAction, provocation).catch(() => {});

  const transcript = history.map(r =>
    `**[${advisorLabel(r.agent)} — Round ${r.round}]**\n${r.content}`
  ).join("\n\n");

  return `${transcript}\n\n**[SYNTHESIS]**\n${synthesis}`;
}
