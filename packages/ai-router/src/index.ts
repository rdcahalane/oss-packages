/**
 * ai-router
 *
 * Unified model routing with automatic provider fallback:
 *   Anthropic (best quality) → OpenAI (good quality) → Gemini Flash
 *
 * All methods try providers in order and move to the next on quota/auth errors.
 * Vision methods support image URLs or base64 data.
 *
 * Usage:
 *   const ai = createAIRouter({
 *     anthropicApiKey: process.env.ANTHROPIC_API_KEY,
 *     openaiApiKey: process.env.OPENAI_API_KEY,
 *     geminiApiKey: process.env.GEMINI_API_KEY,
 *   });
 *
 *   // Text — tries Haiku → GPT-4o-mini → Gemini Flash
 *   const result = await ai.fast({ user: "Summarize this..." });
 *
 *   // Best reasoning — tries Sonnet → GPT-4o → Gemini Flash
 *   const analysis = await ai.best({ system: "You are...", user: "Analyze..." });
 *
 *   // Vision — tries Claude Sonnet → GPT-4o → Gemini Flash
 *   const desc = await ai.vision({ user: "What do you see?", imageUrl: "https://..." });
 *
 *   // Explicit providers (no fallback)
 *   await ai.haiku({ user: "..." });
 *   await ai.sonnet({ user: "..." });
 *   await ai.openai({ user: "..." });          // GPT-4o
 *   await ai.openaiMini({ user: "..." });      // GPT-4o-mini
 *   await ai.gemini({ user: "..." });          // Gemini 2.0 Flash
 */

export interface AIRouterConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  /** Ollama base URL — default http://localhost:11434 */
  ollamaUrl?: string;
  /** Ollama model name — default llama3.2 */
  ollamaModel?: string;
}

export interface CallOptions {
  system?: string;
  user: string;
  maxTokens?: number;
  /** Image URL for vision calls (publicly accessible) */
  imageUrl?: string;
  /** Base64-encoded image data for vision calls */
  imageBase64?: string;
  /** MIME type of image — default image/jpeg */
  imageMimeType?: string;
}

export interface AIRouter {
  /** Anthropic Claude Haiku — fast, cheap extraction/classification */
  haiku(opts: CallOptions): Promise<string>;
  /** Anthropic Claude Sonnet — best reasoning */
  sonnet(opts: CallOptions): Promise<string>;
  /** OpenAI GPT-4o — strong reasoning, vision */
  openai(opts: CallOptions): Promise<string>;
  /** OpenAI GPT-4o-mini — cheap, fast */
  openaiMini(opts: CallOptions): Promise<string>;
  /** Google Gemini 2.0 Flash — free tier, vision */
  gemini(opts: CallOptions): Promise<string>;
  /** Local Ollama → Haiku fallback */
  local(opts: CallOptions): Promise<string>;
  /**
   * Smart fast: Haiku → GPT-4o-mini → Gemini Flash
   * Use for: extraction, classification, summarization, batch tasks
   */
  fast(opts: CallOptions): Promise<string>;
  /**
   * Smart best: Sonnet → GPT-4o → Gemini Flash
   * Use for: reasoning, analysis, drafting, complex tasks
   */
  best(opts: CallOptions): Promise<string>;
  /**
   * Smart vision: Claude Sonnet → GPT-4o → Gemini Flash
   * Use for: photo analysis, image description, visual extraction
   * Pass imageUrl or imageBase64 + imageMimeType
   */
  vision(opts: CallOptions): Promise<string>;
  /** Embed text — Ollama nomic-embed-text → OpenAI text-embedding-3-small */
  embed(text: string): Promise<number[]>;
}

const ANTHROPIC_MODELS = {
  HAIKU: "claude-haiku-4-5-20251001",
  SONNET: "claude-sonnet-4-6",
};

/** Returns true if this is a provider-level failure we should fall through on */
function isProviderError(status: number, bodyText: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status === 429) return true;
  const lower = bodyText.toLowerCase();
  if (status === 400 && (lower.includes("credit") || lower.includes("quota") || lower.includes("balance") || lower.includes("exhausted"))) return true;
  return false;
}

/** Thrown when a provider is unavailable (quota/auth) — triggers waterfall fallback */
class ProviderError extends Error {
  constructor(msg: string) { super(msg); this.name = "ProviderError"; }
}

export function createAIRouter(config: AIRouterConfig): AIRouter {
  const ollamaUrl = config.ollamaUrl ?? "http://localhost:11434";
  const ollamaModel = config.ollamaModel ?? "llama3.2";

  // ── Anthropic ──────────────────────────────────────────────────────────────
  async function callAnthropic(model: string, opts: CallOptions): Promise<string> {
    if (!config.anthropicApiKey) throw new ProviderError("No Anthropic API key");

    const userContent: unknown[] = [];
    if (opts.imageUrl || opts.imageBase64) {
      if (opts.imageUrl) {
        userContent.push({ type: "image", source: { type: "url", url: opts.imageUrl } });
      } else if (opts.imageBase64) {
        userContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: opts.imageMimeType ?? "image/jpeg",
            data: opts.imageBase64,
          },
        });
      }
    }
    userContent.push({ type: "text", text: opts.user });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const bodyText = await r.text();
    if (!r.ok) {
      if (isProviderError(r.status, bodyText)) throw new ProviderError(`Anthropic: ${bodyText.slice(0, 120)}`);
      throw new Error(`Anthropic error ${r.status}: ${bodyText.slice(0, 200)}`);
    }
    const d = JSON.parse(bodyText) as { content?: { text?: string }[] };
    return d.content?.[0]?.text?.trim() ?? "";
  }

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  async function callOpenAI(model: string, opts: CallOptions): Promise<string> {
    if (!config.openaiApiKey) throw new ProviderError("No OpenAI API key");

    const userParts: unknown[] = [];
    if (opts.imageUrl) {
      userParts.push({ type: "image_url", image_url: { url: opts.imageUrl, detail: "high" } });
    } else if (opts.imageBase64) {
      const mime = opts.imageMimeType ?? "image/jpeg";
      userParts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${opts.imageBase64}`, detail: "high" } });
    }
    userParts.push({ type: "text", text: opts.user });

    const messages: unknown[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: userParts });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 4096 }),
    });

    const bodyText = await r.text();
    if (!r.ok) {
      if (isProviderError(r.status, bodyText)) throw new ProviderError(`OpenAI: ${bodyText.slice(0, 120)}`);
      throw new Error(`OpenAI error ${r.status}: ${bodyText.slice(0, 200)}`);
    }
    const d = JSON.parse(bodyText) as { choices?: { message?: { content?: string } }[] };
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }

  // ── Gemini ─────────────────────────────────────────────────────────────────
  async function callGemini(opts: CallOptions): Promise<string> {
    if (!config.geminiApiKey) throw new ProviderError("No Gemini API key");

    const parts: unknown[] = [];
    if (opts.imageUrl) {
      // Fetch image and convert to base64 for Gemini inline data
      try {
        const imgRes = await fetch(opts.imageUrl);
        if (imgRes.ok) {
          const buf = await imgRes.arrayBuffer();
          const base64 = Buffer.from(buf).toString("base64");
          const mime = opts.imageMimeType ?? imgRes.headers.get("content-type") ?? "image/jpeg";
          parts.push({ inlineData: { mimeType: mime, data: base64 } });
        }
      } catch { /* skip image if fetch fails */ }
    } else if (opts.imageBase64) {
      parts.push({ inlineData: { mimeType: opts.imageMimeType ?? "image/jpeg", data: opts.imageBase64 } });
    }
    parts.push({ text: opts.user });

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 4096 },
    };
    if (opts.system) {
      body.systemInstruction = { parts: [{ text: opts.system }] };
    }

    const model = "gemini-2.0-flash";
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );

    const bodyText = await r.text();
    if (!r.ok) {
      if (isProviderError(r.status, bodyText)) throw new ProviderError(`Gemini: ${bodyText.slice(0, 120)}`);
      throw new Error(`Gemini error ${r.status}: ${bodyText.slice(0, 200)}`);
    }
    const d = JSON.parse(bodyText) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  }

  // ── Ollama ─────────────────────────────────────────────────────────────────
  async function callOllama(opts: CallOptions): Promise<string | null> {
    try {
      const r = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          messages: [
            ...(opts.system ? [{ role: "system", content: opts.system }] : []),
            { role: "user", content: opts.user },
          ],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return null;
      const d = await r.json() as { message?: { content?: string } };
      return d.message?.content?.trim() ?? null;
    } catch {
      return null;
    }
  }

  // ── Waterfall helper ───────────────────────────────────────────────────────
  async function waterfall(providers: (() => Promise<string>)[]): Promise<string> {
    const errors: string[] = [];
    for (const fn of providers) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ProviderError) {
          errors.push(e.message);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`All providers failed: ${errors.join(" | ")}`);
  }

  return {
    haiku: (opts) => callAnthropic(ANTHROPIC_MODELS.HAIKU, opts),
    sonnet: (opts) => callAnthropic(ANTHROPIC_MODELS.SONNET, opts),
    openai: (opts) => callOpenAI("gpt-4o", opts),
    openaiMini: (opts) => callOpenAI("gpt-4o-mini", opts),
    gemini: (opts) => callGemini(opts),

    async local(opts) {
      const result = await callOllama(opts);
      if (result !== null) return result;
      return waterfall([
        () => callAnthropic(ANTHROPIC_MODELS.HAIKU, opts),
        () => callOpenAI("gpt-4o-mini", opts),
        () => callGemini(opts),
      ]);
    },

    fast: (opts) => waterfall([
      () => callAnthropic(ANTHROPIC_MODELS.HAIKU, opts),
      () => callOpenAI("gpt-4o-mini", opts),
      () => callGemini(opts),
    ]),

    best: (opts) => waterfall([
      () => callAnthropic(ANTHROPIC_MODELS.SONNET, opts),
      () => callOpenAI("gpt-4o", opts),
      () => callGemini(opts),
    ]),

    vision: (opts) => waterfall([
      () => callAnthropic(ANTHROPIC_MODELS.SONNET, opts),
      () => callOpenAI("gpt-4o", opts),
      () => callGemini(opts),
    ]),

    async embed(text) {
      try {
        const r = await fetch(`${ollamaUrl}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const d = await r.json() as { embedding?: number[] };
          if (d.embedding) return d.embedding;
        }
      } catch { /* fall through */ }

      if (config.openaiApiKey) {
        const r = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openaiApiKey}` },
          body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
        });
        const d = await r.json() as { data?: { embedding: number[] }[] };
        if (d.data?.[0]) return d.data[0].embedding;
      }

      throw new Error("No embedding provider available");
    },
  };
}
