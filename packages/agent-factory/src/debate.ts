import type { AgentTask } from "./coordinator.js";

export type AgentName = "claude" | "codex" | "gemini" | "local" | "beast" | "openai";

interface Round {
  agent: AgentName;
  round: number;
  content: string;
}

async function getAgent(name: AgentName) {
  switch (name) {
    case "beast":  return (await import("./agents/beast.js")).execute;
    case "gemini": return (await import("./agents/gemini-cli.js")).execute;
    case "local":  return (await import("./agents/local.js")).execute;
    case "codex":
    case "openai": return (await import("./agents/codex-cli.js")).execute;
    case "claude":
    default:       return (await import("./agents/claude-cli.js")).execute;
  }
}

function buildRoundPrompt(topic: string, history: Round[], currentAgent: AgentName, isRedTeam: boolean): string {
  const transcript = history.map(r =>
    `[${r.agent.toUpperCase()} — Round ${r.round}]\n${r.content}`
  ).join("\n\n---\n\n");

  const instruction = isRedTeam
    ? `You are ${currentAgent.toUpperCase()} playing RED TEAM. Your job is adversarial: ` +
      `attack the dominant view, expose hidden assumptions, find the worst-case scenario, ` +
      `and refuse easy consensus. Steelman the strongest objection. Do NOT be balanced — ` +
      `stress-test the emerging position. 2-3 paragraphs max.`
    : `You are ${currentAgent.toUpperCase()}. Respond to the most recent arguments: challenge weak points, ` +
      `concede strong ones, and sharpen your position. Be concise (2-3 paragraphs max).`;

  return `You are in a structured debate with multiple participants. Topic: "${topic}"\n\n` +
    `Debate so far:\n\n${transcript}\n\n---\n\n${instruction}`;
}

function buildSynthesisPrompt(topic: string, history: Round[], agents: AgentName[], redTeam: AgentName): string {
  const transcript = history.map(r =>
    `[${r.agent.toUpperCase()} — Round ${r.round}]\n${r.content}`
  ).join("\n\n---\n\n");

  const names = agents.map(a => a.toUpperCase()).join(", ");
  return `You are a neutral synthesizer. A structured debate just concluded between ${names} on: "${topic}"\n\n` +
    `Note: ${redTeam.toUpperCase()} played Red Team — their arguments were intentionally adversarial.\n\n` +
    `Transcript:\n\n${transcript}\n\n---\n\n` +
    `Synthesize all positions. Call out which Red Team objections were valid vs. weak. ` +
    `Where agents agreed under adversarial pressure, treat that as strong signal. ` +
    `Verdict first, then reasoning.\n\n` +
    `End your response with exactly this line (fill in the blank):\n` +
    `PROPOSED ACTION: [one concrete sentence — what should be done next based on this debate]`;
}

export function extractProposedAction(synthesis: string): string | null {
  const match = synthesis.match(/PROPOSED ACTION:\s*(.+?)(?:\n|$)/i);
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
  } = task.payload as { prompt: string; agents?: string[]; rounds?: number; red_team?: string };

  const agents: AgentName[] = rawAgents?.length
    ? rawAgents.map(a => a as AgentName)
    : ["claude", "local"];

  const redTeam: AgentName = (rawRedTeam as AgentName) ?? agents[1];

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
  const firstExecute = await getAgent(agents[0]);
  const opening = await firstExecute(openingTask);
  history.push({ agent: agents[0], round: 1, content: opening });
  onRound(task, agents[0], 1, opening);

  // Round-robin
  for (let r = 2; r <= totalRounds; r++) {
    const current = agents[r % agents.length];
    const roundTask: AgentTask = {
      ...task,
      payload: {
        prompt: contextPrefix + buildRoundPrompt(topic, history, current, current === redTeam),
        max_tokens: 600,
      },
    };
    const execute = await getAgent(current);
    const response = await execute(roundTask);
    history.push({ agent: current, round: r, content: response });
    onRound(task, current, r, response);
  }

  // Synthesis — default to claude, fallback to first available agent
  const synthTask: AgentTask = {
    ...task,
    payload: {
      prompt: buildSynthesisPrompt(topic, history, agents, redTeam),
      max_tokens: 800,
    },
  };
  const synthesizer = await getAgent("claude");
  const synthesis = await synthesizer(synthTask);

  const transcript = history.map(r =>
    `**[${r.agent.toUpperCase()} — Round ${r.round}]**\n${r.content}`
  ).join("\n\n");

  return `${transcript}\n\n**[SYNTHESIS]**\n${synthesis}`;
}
