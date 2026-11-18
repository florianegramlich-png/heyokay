import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

/**
 * Thin wrapper so the pipeline never depends on a specific provider.
 * No user identifiers or user locations are ever sent — only public source text.
 * Returns null when no API key is configured or the call fails; callers fall back to rules/templates.
 */
export interface LlmUsage { inputTokens: number; outputTokens: number }

export interface StructuredLLM {
  readonly enabled: boolean;
  generate<T extends z.ZodType>(system: string, user: string, schema: T): Promise<z.infer<T> | null>;
}

export class AnthropicLLM implements StructuredLLM {
  private client: Anthropic | null;
  /** Called after every successful call with the tokens used (cost tracking, llm-budget.ts). */
  onUsage?: (u: LlmUsage) => void;
  constructor(apiKey: string | null, private model: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get enabled() {
    return this.client !== null;
  }

  async generate<T extends z.ZodType>(system: string, user: string, schema: T): Promise<z.infer<T> | null> {
    if (!this.client) return null;
    try {
      const msg = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: zodOutputFormat(schema) },
      });
      this.onUsage?.({ inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 });
      return (msg.parsed_output ?? null) as z.infer<T> | null;
    } catch (err) {
      console.warn('[llm] call failed, falling back:', (err as Error).message);
      return null;
    }
  }
}

/** Deterministic stand-in for tests and offline runs. */
export class NoLLM implements StructuredLLM {
  readonly enabled = false;
  async generate(): Promise<null> {
    return null;
  }
}
