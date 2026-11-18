import { createHash } from 'node:crypto';

/**
 * Text embeddings for dedup (PRD 6.1 #3): two differently-worded reports of the same incident
 * should land close together. Only public source text is ever sent — never user data or locations.
 * `embed` returns null when disabled or when the call fails; clustering then falls back to word overlap.
 */
export interface Embedder {
  readonly enabled: boolean;
  /** Stored next to each vector; vectors from different models are never compared. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][] | null>;
}

/** No provider configured: clustering uses word overlap only. */
export class NoEmbedder implements Embedder {
  readonly enabled = false;
  readonly model = 'none';
  async embed(): Promise<null> {
    return null;
  }
}

export interface HttpEmbedderOptions {
  url: string;
  apiKey: string;
  model: string;
  /** Ask the provider for this many dimensions, if it supports it (OpenAI `text-embedding-3-*`). */
  dimensions?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Any provider with the OpenAI-style `POST /embeddings` shape: `{ model, input: [...] }` →
 * `{ data: [{ index, embedding }] }`. That covers Mistral (EU-hosted), OpenAI and Voyage.
 */
export class HttpEmbedder implements Embedder {
  readonly enabled = true;
  readonly model: string;
  constructor(private o: HttpEmbedderOptions) {
    this.model = o.dimensions ? `${o.model}@${o.dimensions}` : o.model;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!texts.length) return [];
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({ model: this.o.model, input: texts, ...(this.o.dimensions ? { dimensions: this.o.dimensions } : {}) }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
      const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== texts.length) throw new Error(`expected ${texts.length} embeddings, got ${rows.length}`);
      const out = rows.map((r) => r.embedding);
      if (!out.every((v): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x)))) {
        throw new Error('malformed embedding');
      }
      return out;
    } catch (err) {
      console.warn('[embeddings] call failed, falling back to word overlap:', (err as Error).message);
      return null;
    }
  }
}

/**
 * Deterministic stand-in for tests and offline runs. Words are lower-cased, mapped to a concept
 * through `synonyms` (so "Brand" and "Feuer" count as the same thing), then hashed into a fixed
 * number of dimensions and L2-normalised. Same input → same vector, on every machine.
 */
export class FakeEmbedder implements Embedder {
  readonly enabled = true;
  readonly model: string;
  calls = 0;
  private concept = new Map<string, string>();
  constructor(synonyms: string[][] = [], private dims = 64) {
    this.model = `fake-${dims}`;
    for (const group of synonyms) for (const w of group) this.concept.set(w.toLowerCase(), group[0].toLowerCase());
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (const word of t.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)) {
        if (word.length < 3 || FAKE_STOPWORDS.has(word)) continue;
        const c = this.concept.get(word) ?? word;
        const h = createHash('sha256').update(c).digest();
        v[h.readUInt32BE(0) % this.dims] += h[4] & 1 ? 1 : -1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

/** Function words carry no meaning for a real model either; the fake drops them. */
const FAKE_STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines', 'und', 'oder', 'mit', 'von',
  'für', 'auf', 'aus', 'bei', 'nach', 'wegen', 'ist', 'sind', 'wird', 'wurde', 'werden', 'es', 'sich', 'bitte', 'sollen',
  'halten', 'starker', 'the', 'and', 'for', 'with',
]);

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The text that represents an event for dedup: what happened, not where (geo is checked separately). */
export function embeddingText(e: { title: string; summary: string }): string {
  return `${e.title}\n${e.summary}`.slice(0, 2000);
}

export interface EmbeddingsConfig {
  embeddingsUrl: string | null;
  embeddingsApiKey: string | null;
  embeddingsModel: string | null;
  embeddingsDimensions: number | null;
}

export function createEmbedder(c: EmbeddingsConfig): Embedder {
  if (!c.embeddingsUrl || !c.embeddingsApiKey || !c.embeddingsModel) return new NoEmbedder();
  return new HttpEmbedder({
    url: c.embeddingsUrl, apiKey: c.embeddingsApiKey, model: c.embeddingsModel,
    ...(c.embeddingsDimensions ? { dimensions: c.embeddingsDimensions } : {}),
  });
}
