/**
 * action-items
 *
 * Extract structured action items from documents, transcripts, and messages
 * using Claude Haiku. Returns JSON-typed results ready to store or display.
 *
 * Usage:
 *   import { createActionItemExtractor } from "action-items";
 *
 *   const extract = createActionItemExtractor({
 *     anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
 *   });
 *
 *   const items = await extract({ title: "Q1 Planning", content: transcript });
 */

export interface ActionItem {
  /** Imperative description: "Schedule weekly sync with engineering team" */
  description: string;
  /** Name or role if mentioned, else null */
  assignee: string | null;
  /** ISO date (YYYY-MM-DD) if mentioned, else null */
  due_date: string | null;
  priority: "high" | "medium" | "low";
  /** Relevant quote from source for traceability */
  context: string | null;
}

export interface ActionItemExtractorConfig {
  anthropicApiKey: string;
  /** Claude model to use — default claude-haiku-4-5-20251001 */
  model?: string;
  /** Max characters of content to send to the model — default 8000 */
  maxContentLength?: number;
}

export type ActionItemExtractFn = (params: {
  title: string;
  content: string;
}) => Promise<ActionItem[]>;

const SYSTEM_PROMPT = `You are an operations analyst assistant. Your job is to extract concrete action items from meeting transcripts, documents, and messages.

Rules:
- Only extract items with a clear owner or assignee, or where the action is concrete and unambiguous
- Ignore vague statements, general observations, or background context
- Extract the immediate next action, not high-level goals
- If a due date is mentioned, extract it in ISO format (YYYY-MM-DD)
- Priority: "high" if urgent/blocking, "medium" if near-term, "low" if long-term or nice-to-have
- Context: include the relevant sentence or short paragraph from the source for traceability
- Return ONLY valid JSON, no prose`;

/**
 * Create an action item extractor bound to your Anthropic API key and config.
 */
export function createActionItemExtractor(
  config: ActionItemExtractorConfig,
): ActionItemExtractFn {
  const {
    anthropicApiKey,
    model = "claude-haiku-4-5-20251001",
    maxContentLength = 8000,
  } = config;

  return async function extract({ title, content }): Promise<ActionItem[]> {
    if (!content || content.trim().length < 50) return [];

    const userPrompt = `Extract action items from this document.

Title: ${title}

Content:
${content.slice(0, maxContentLength)}

Return a JSON array. Each item:
{
  "description": "Clear action in imperative form (e.g. 'Schedule weekly sync with engineering team')",
  "assignee": "Name or role if mentioned, else null",
  "due_date": "YYYY-MM-DD if mentioned, else null",
  "priority": "high|medium|low",
  "context": "Relevant quote from source text"
}

If no clear action items exist, return [].`;

    let raw: string;
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (!response.ok) {
        const e = await response.json().catch(() => ({})) as { error?: { message: string } };
        throw new Error(e.error?.message ?? `Anthropic API error ${response.status}`);
      }
      const data = await response.json() as { content?: { text?: string }[] };
      raw = data.content?.[0]?.text ?? "[]";
    } catch (err) {
      console.error("[action-items] API error:", (err as Error).message);
      return [];
    }

    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    try {
      const items = JSON.parse(cleaned);
      return Array.isArray(items) ? (items as ActionItem[]) : [];
    } catch {
      console.warn("[action-items] Failed to parse response:", cleaned.slice(0, 200));
      return [];
    }
  };
}
