import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { FailoverLLM, OpenAICompatLLM, PAUSE_MS, createLLM, jsonSchemaFor, parseJsonText, parseProviders } from '../src/llm-providers.js';
import { BudgetedLLM } from '../src/llm-budget.js';
import { SqliteStore } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import type { LlmUsage, StructuredLLM } from '../src/llm.js';

const Schema = z.object({ title: z.string(), severity: z.number().int().min(1).max(5), places: z.array(z.string()), note: z.string().nullable() });
const good = { title: 'Sturmböen in Berlin', severity: 2, places: ['Berlin'], note: null };

/** Records requests and answers like an OpenAI-style chat API. */
function fakeApi(answer: (body: any) => { status?: number; json?: unknown }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const a = answer(body);
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const chat = (content: unknown, usage = { prompt_tokens: 120, completion_tokens: 40 }) => ({ json: { choices: [{ message: { content }, finish_reason: 'stop' }], usage } });

describe('OpenAI-style provider (Mistral, OpenAI, open-weight servers)', () => {
  it('sends the schema as json_schema and returns the checked answer; reports tokens', async () => {
    const api = fakeApi(() => chat(JSON.stringify(good)));
    const usage: LlmUsage[] = [];
    const llm = new OpenAICompatLLM({ name: 'mistral', baseUrl: 'https://api.mistral.ai/v1/', apiKey: 'k', model: 'mistral-small-latest', fetch: api.fetch });
    llm.onUsage = (u) => usage.push(u);
    expect(await llm.generate('Extract.', 'Text', Schema)).toEqual(good);
    const req = api.calls[0];
    expect(req.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer k');
    expect(req.body).toMatchObject({ model: 'mistral-small-latest', temperature: 0, messages: [{ role: 'system', content: 'Extract.' }, { role: 'user', content: 'Text' }] });
    expect(req.body.response_format.type).toBe('json_schema');
    expect(req.body.response_format.json_schema.schema).toEqual(jsonSchemaFor(Schema));
    expect(req.body.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(usage).toEqual([{ inputTokens: 120, outputTokens: 40 }]);
  });

  it('json_object mode puts the schema in the prompt; fences and content parts are understood', async () => {
    const api = fakeApi(() => chat([{ type: 'text', text: '```json\n' }, { type: 'text', text: JSON.stringify(good) + '\n```' }]));
    const llm = new OpenAICompatLLM({ name: 'openai_compat', baseUrl: 'http://vllm.internal/v1', apiKey: '', model: 'llama', jsonMode: 'object', fetch: api.fetch });
    expect(await llm.generate('Extract.', 'Text', Schema)).toEqual(good);
    expect(api.calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(api.calls[0].body.messages[0].content).toContain('"severity"');
    expect(parseJsonText(' {"a":1} ')).toEqual({ a: 1 });
  });

  it('HTTP errors, empty answers, broken JSON and answers outside the schema all give null; tokens still count', async () => {
    const usage: LlmUsage[] = [];
    for (const a of [{ status: 429 }, chat(''), chat('{not json'), chat(JSON.stringify({ ...good, severity: 9 })), { json: {} }]) {
      const llm = new OpenAICompatLLM({ name: 'mistral', baseUrl: 'x', apiKey: 'k', model: 'm', fetch: fakeApi(() => a).fetch });
      llm.onUsage = (u) => usage.push(u);
      expect(await llm.generate('s', 'u', Schema)).toBeNull();
    }
    expect(usage).toHaveLength(3); // the three answers that came with usage
  });
});

/** A provider that answers from a script: true = good answer, false = failure. */
function scripted(name: string, script: boolean[]) {
  let i = 0;
  const p: StructuredLLM & { name: string; calls: number; onUsage?: (u: LlmUsage) => void } = {
    name, enabled: true, calls: 0,
    async generate() {
      p.calls++;
      const ok = script[i++] ?? script.at(-1);
      if (ok) p.onUsage?.({ inputTokens: 1000, outputTokens: 0 });
      return (ok ? { ...good, title: name } : null) as any;
    },
  };
  return p;
}

describe('failover', () => {
  it('uses the first provider; the next one only when it fails', async () => {
    const a = scripted('anthropic', [true, false, true]);
    const b = scripted('mistral', [true]);
    const llm = new FailoverLLM([a, b], Date.now, () => {});
    expect((await llm.generate('s', 'u', Schema))?.title).toBe('anthropic');
    expect((await llm.generate('s', 'u', Schema))?.title).toBe('mistral');
    expect(llm.lastProvider).toBe('mistral');
    expect((await llm.generate('s', 'u', Schema))?.title).toBe('anthropic');
    expect([a.calls, b.calls]).toEqual([3, 1]);
  });

  it('after 3 failures in a row a provider is skipped for 5 minutes, then tried again', async () => {
    let now = 0;
    const a = scripted('anthropic', [false, false, false, true]);
    const b = scripted('mistral', [true]);
    const llm = new FailoverLLM([a, b], () => now, () => {});
    for (let i = 0; i < 3; i++) await llm.generate('s', 'u', Schema);
    expect(a.calls).toBe(3);
    await llm.generate('s', 'u', Schema);
    expect(a.calls).toBe(3); // paused
    now = PAUSE_MS + 1;
    expect((await llm.generate('s', 'u', Schema))?.title).toBe('anthropic');
  });

  it('all failing → null (templates take over); all paused → still tried', async () => {
    let now = 0;
    const a = scripted('anthropic', [false]);
    const b = scripted('mistral', [false]);
    const llm = new FailoverLLM([a, b], () => now, () => {});
    for (let i = 0; i < 4; i++) expect(await llm.generate('s', 'u', Schema)).toBeNull();
    expect([a.calls, b.calls]).toEqual([4, 4]);
    expect(new FailoverLLM([]).enabled).toBe(false);
  });

  it('the AI budget counts tokens from whichever provider answered', async () => {
    const store = new SqliteStore(':memory:');
    const a = scripted('anthropic', [false]);
    const b = scripted('mistral', [true]);
    const llm = new BudgetedLLM(new FailoverLLM([a, b], Date.now, () => {}), store, { dailyBudgetEur: 5, priceInPerMTok: 1000, priceOutPerMTok: 0 }, () => new Date('2026-11-21T10:00:00Z'));
    await llm.generate('s', 'u', Schema);
    expect(await llm.spent()).toBeCloseTo(1); // 1000 tokens × €1000 / M
    await store.close();
  });
});

describe('settings', () => {
  it('LLM_PROVIDERS order, unknown names refused, providers without keys left out', () => {
    expect(parseProviders(undefined)).toEqual(['anthropic']);
    expect(parseProviders(' Mistral, anthropic,mistral ')).toEqual(['mistral', 'anthropic']);
    expect(() => parseProviders('anthropic,gemini')).toThrow(/gemini/);

    expect(createLLM(loadConfig({})).enabled).toBe(false);
    const both = createLLM(loadConfig({ LLM_PROVIDERS: 'anthropic,mistral,openai_compat', ANTHROPIC_API_KEY: 'a', MISTRAL_API_KEY: 'm' }));
    expect(both.names).toEqual(['anthropic', 'mistral']);
    const eu = createLLM(loadConfig({ LLM_PROVIDERS: 'mistral,openai_compat', ANTHROPIC_API_KEY: 'a', MISTRAL_API_KEY: 'm', OPENAI_COMPAT_URL: 'http://x/v1', OPENAI_COMPAT_MODEL: 'llama' }));
    expect(eu.names).toEqual(['mistral', 'openai_compat']);
    expect(loadConfig({}).mistralModel).toBe('mistral-small-latest');
  });
});
