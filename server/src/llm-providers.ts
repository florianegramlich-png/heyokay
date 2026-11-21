import { z } from 'zod';
import { AnthropicLLM, type LlmUsage, type StructuredLLM } from './llm.js';
import type { Config } from './config.js';
import { logError, defaultSink, type ErrorSink } from './errors.js';

/**
 * More than one AI provider (PRD 6.3, 6.4, Decision 12).
 *
 * - `OpenAICompatLLM`: any `POST /chat/completions` API in the OpenAI shape with JSON output.
 *   That covers Mistral (EU, `https://api.mistral.ai/v1`), OpenAI, and open-weight models served
 *   by vLLM / TGI / Ollama on EU hosting.
 * - `FailoverLLM`: tries providers in the `LLM_PROVIDERS` order; a provider that fails is tried
 *   again on the next call, but after 3 failures in a row it is skipped for 5 minutes. When all
 *   fail, the result is null and the pipeline's templates take over, as before.
 *
 * As with the Anthropic client, only public source text is sent, never user data. The answer is
 * always checked against the zod schema; anything that doesn't fit counts as a failure.
 */

export interface OpenAICompatOptions {
  /** Short name for logs and `LLM_PROVIDERS` (e.g. `mistral`). */
  name: string;
  /** Base URL up to `/v1`, without `/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * `schema` (default): `response_format: json_schema` (Mistral, OpenAI, vLLM).
   * `object`: `response_format: json_object` with the schema in the prompt, for servers without
   * schema support.
   */
  jsonMode?: 'schema' | 'object';
  timeoutMs?: number;
  maxTokens?: number;
  fetch?: typeof fetch;
}

/** The JSON Schema we send: zod's, without the `$schema` line some providers reject. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** The model's text as JSON: tolerates a ```json fence around it. */
export function parseJsonText(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}

export class OpenAICompatLLM implements StructuredLLM {
  readonly enabled = true;
  onUsage?: (u: LlmUsage) => void;
  constructor(private o: OpenAICompatOptions) {}

  get name() { return this.o.name; }

  async generate<T extends z.ZodType>(system: string, user: string, schema: T): Promise<z.infer<T> | null> {
    try {
      const jsonSchema = jsonSchemaFor(schema);
      const mode = this.o.jsonMode ?? 'schema';
      const sys = mode === 'object' ? `${system}\n\nAnswer with one JSON object only, matching this JSON Schema:\n${JSON.stringify(jsonSchema)}` : system;
      const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model: this.o.model,
          max_tokens: this.o.maxTokens ?? 1024,
          temperature: 0,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          response_format: mode === 'object'
            ? { type: 'json_object' }
            : { type: 'json_schema', json_schema: { name: 'answer', schema: jsonSchema, strict: true } },
        }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // Tokens are paid for even when the answer turns out unusable.
      if (body.usage) this.onUsage?.({ inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 });
      const content = body.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('') : null;
      if (!text) throw new Error(`no content (finish: ${body.choices?.[0]?.finish_reason ?? 'none'})`);
      const parsed = schema.safeParse(parseJsonText(text));
      if (!parsed.success) throw new Error(`answer doesn't match the schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      return parsed.data as z.infer<T>;
    } catch (err) {
      console.warn(`[llm:${this.o.name}] call failed:`, (err as Error).message);
      return null;
    }
  }
}

type Provider = StructuredLLM & { onUsage?: (u: LlmUsage) => void; readonly name?: string };

export const FAILS_BEFORE_PAUSE = 3;
export const PAUSE_MS = 5 * 60_000;

export class FailoverLLM implements StructuredLLM {
  private state = new Map<Provider, { fails: number; pausedUntil: number }>();
  /** Which provider answered the last successful call (logs, tests). */
  lastProvider: string | null = null;

  constructor(private readonly providers: Provider[], private readonly now: () => number = Date.now, private readonly sink: ErrorSink = defaultSink) {
    for (const p of providers) this.state.set(p, { fails: 0, pausedUntil: 0 });
  }

  get enabled() {
    return this.providers.some((p) => p.enabled);
  }

  /** Names of the providers in use, in order (startup log). */
  get names(): string[] {
    return this.providers.filter((p) => p.enabled).map((p) => p.name ?? '?');
  }

  /** Usage from whichever provider answers goes to the budget guard (llm-budget.ts). */
  set onUsage(fn: ((u: LlmUsage) => void) | undefined) {
    for (const p of this.providers) p.onUsage = fn;
  }

  async generate<T extends z.ZodType>(system: string, user: string, schema: T): Promise<z.infer<T> | null> {
    const now = this.now();
    const live = this.providers.filter((p) => p.enabled);
    const ready = live.filter((p) => this.state.get(p)!.pausedUntil <= now);
    // All paused: try them anyway rather than give up on AI for minutes.
    for (const p of ready.length ? ready : live) {
      const out = await p.generate(system, user, schema);
      const s = this.state.get(p)!;
      if (out != null) {
        s.fails = 0;
        this.lastProvider = p.name ?? null;
        return out;
      }
      s.fails++;
      if (s.fails >= FAILS_BEFORE_PAUSE) {
        if (s.fails === FAILS_BEFORE_PAUSE) logError('llm', new Error(`AI provider ${p.name ?? '?'} failed ${s.fails} times in a row; skipping it for 5 minutes`), {}, this.sink);
        s.pausedUntil = now + PAUSE_MS;
      }
    }
    this.lastProvider = null;
    return null;
  }
}

export const LLM_PROVIDER_NAMES = ['anthropic', 'mistral', 'openai_compat'] as const;
export type LlmProviderName = (typeof LLM_PROVIDER_NAMES)[number];

export function parseProviders(raw: string | undefined): LlmProviderName[] {
  const names = (raw ?? 'anthropic').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (!(LLM_PROVIDER_NAMES as readonly string[]).includes(n)) throw new Error(`LLM_PROVIDERS: unknown provider "${n}" (known: ${LLM_PROVIDER_NAMES.join(', ')})`);
  return [...new Set(names)] as LlmProviderName[];
}

/**
 * The providers from the settings, in `LLM_PROVIDERS` order, behind failover. Providers without
 * a key are left out; with none left the result is disabled and templates are used.
 */
export function createLLM(c: Pick<Config, 'llmProviders' | 'anthropicApiKey' | 'model' | 'mistralApiKey' | 'mistralModel' | 'mistralUrl' | 'openaiCompatUrl' | 'openaiCompatApiKey' | 'openaiCompatModel' | 'openaiCompatJsonMode'>): FailoverLLM {
  const list: Provider[] = [];
  for (const name of c.llmProviders) {
    if (name === 'anthropic' && c.anthropicApiKey) list.push(new AnthropicLLM(c.anthropicApiKey, c.model));
    if (name === 'mistral' && c.mistralApiKey) list.push(new OpenAICompatLLM({ name, baseUrl: c.mistralUrl, apiKey: c.mistralApiKey, model: c.mistralModel }));
    if (name === 'openai_compat' && c.openaiCompatUrl && c.openaiCompatModel) {
      list.push(new OpenAICompatLLM({ name, baseUrl: c.openaiCompatUrl, apiKey: c.openaiCompatApiKey ?? '', model: c.openaiCompatModel, jsonMode: c.openaiCompatJsonMode }));
    }
  }
  return new FailoverLLM(list);
}
