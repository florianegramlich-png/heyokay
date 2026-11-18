import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { z } from 'zod';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import type { StructuredLLM } from '../src/llm.js';
import type { Geocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { findCluster, newEvent } from '../src/pipeline/cluster.js';
import { FakeEmbedder, HttpEmbedder, NoEmbedder, cosine, createEmbedder, embeddingText, type Embedder } from '../src/embeddings.js';
import type { ExtractedEvent, SourceItem } from '../src/types.js';

// PRD 6.1 #3: differently-worded reports of the same incident become one event.

const NOW = new Date('2026-11-18T09:00:00+01:00');
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4, embeddingsMinSimilarity: 0.8 };

/** Brand/Feuer etc. are the same concept for the fake, as they would be close for a real model. */
const SYNONYMS = [
  ['brand', 'feuer', 'brennt', 'löscht', 'löschen'],
  ['wohnhaus', 'mehrfamilienhaus', 'wohngebäude'],
  ['rauch', 'qualm', 'rauchentwicklung', 'qualmentwicklung'],
  ['fenster', 'türen'],
  ['schließen', 'geschlossen'],
  ['anwohner', 'anwohnende', 'nachbarn'],
];

const PLACES: Record<string, { lat: number; lon: number }> = {
  'Warschauer Straße, Berlin': { lat: 52.5059, lon: 13.4492 },
  'Revaler Straße, Berlin': { lat: 52.5085, lon: 13.4563 }, // ~560 m away: beyond the 300 m "same spot" rule
};
const geocoder: Geocoder = {
  async geocode(q: string) { const p = PLACES[q]; return p ? { name: q, ...p, radiusM: 300 } : null; },
};

/** Extraction as the model would return it, keyed by the item's title. */
const EXTRACTIONS: Record<string, unknown> = {
  'Brand in Wohnhaus an der Warschauer Straße': {
    isCurrentSafetyEvent: true, category: 'public_safety', severity: 3, confidence: 0.9,
    title: 'Brand in Wohnhaus an der Warschauer Straße',
    summary: 'In einem Wohnhaus brennt es. Anwohner sollen wegen Rauch Fenster und Türen schließen.',
    place: 'Warschauer Straße, Berlin', radiusM: 500, endsAt: null,
  },
  'Feuer in Mehrfamilienhaus in der Revaler Straße': {
    isCurrentSafetyEvent: true, category: 'public_safety', severity: 3, confidence: 0.9,
    title: 'Feuer in Mehrfamilienhaus in der Revaler Straße',
    summary: 'Die Feuerwehr löscht ein Feuer in einem Mehrfamilienhaus. Wegen starker Qualmentwicklung bitte Fenster geschlossen halten.',
    place: 'Revaler Straße, Berlin', radiusM: 500, endsAt: null,
  },
  'Blindgänger an der Revaler Straße gefunden': {
    isCurrentSafetyEvent: true, category: 'public_safety', severity: 3, confidence: 0.9,
    title: 'Blindgänger an der Revaler Straße gefunden',
    summary: 'Bei Bauarbeiten wurde eine Weltkriegsbombe entdeckt. Der Bereich ist abgesperrt.',
    place: 'Revaler Straße, Berlin', radiusM: 500, endsAt: null,
  },
};
class ExtractionLLM implements StructuredLLM {
  readonly enabled = true;
  async generate<T extends z.ZodType>(_s: string, user: string, schema: T) {
    const title = Object.keys(EXTRACTIONS).find((t) => user.includes(t));
    // Only the extraction call is scripted; alert writing falls back to templates.
    const parsed = title ? schema.safeParse(EXTRACTIONS[title]) : null;
    return parsed?.success ? (parsed.data as z.infer<T>) : null;
  }
}

function rss(id: string, sourceName: string, title: string, body: string): SourceItem {
  return { source: 'rss', sourceName, externalId: id, official: false, title, body, publishedAt: NOW.toISOString() };
}
const POLICE = rss('p1', 'Polizei Berlin', 'Brand in Wohnhaus an der Warschauer Straße',
  'In einem Wohnhaus an der Warschauer Straße brennt es. Anwohner sollen wegen Rauch Fenster und Türen schließen.');
const FIRE = rss('f1', 'Berliner Feuerwehr', 'Feuer in Mehrfamilienhaus in der Revaler Straße',
  'Die Feuerwehr löscht ein Feuer in einem Mehrfamilienhaus. Wegen starker Qualmentwicklung bitte Fenster geschlossen halten.');
const BOMB = rss('b1', 'Polizei Berlin', 'Blindgänger an der Revaler Straße gefunden',
  'Bei Bauarbeiten wurde eine Weltkriegsbombe entdeckt. Der Bereich ist abgesperrt.');

class FailingEmbedder implements Embedder {
  readonly enabled = true;
  readonly model = 'down';
  calls = 0;
  async embed() { this.calls++; return null; }
}

describe('embeddings', () => {
  it('the fake is deterministic and puts synonyms close together', async () => {
    const f = new FakeEmbedder(SYNONYMS);
    const [a, b, c] = await f.embed([embeddingText(EXTRACTIONS[POLICE.title] as any), embeddingText(EXTRACTIONS[FIRE.title] as any), embeddingText(EXTRACTIONS[BOMB.title] as any)]);
    expect(await f.embed([embeddingText(EXTRACTIONS[POLICE.title] as any)])).toEqual([a]);
    expect(cosine(a, b)).toBeGreaterThanOrEqual(0.8);
    expect(cosine(a, c)).toBeLessThan(0.5);
    expect(cosine(b, c)).toBeLessThan(0.5);
  });

  it('the HTTP provider sends the OpenAI-style request and orders results by index', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = new HttpEmbedder({ url: 'https://api.example.eu/v1/embeddings', apiKey: 'k', model: 'embed-x', dimensions: 256, fetch: fakeFetch });
    expect(await e.embed(['a', 'b'])).toEqual([[1, 0], [0, 1]]);
    expect(e.model).toBe('embed-x@256');
    expect(calls[0].url).toBe('https://api.example.eu/v1/embeddings');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'embed-x', input: ['a', 'b'], dimensions: 256 });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('the HTTP provider returns null on errors and malformed answers, so clustering falls back', async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const mk = (f: typeof fetch) => new HttpEmbedder({ url: 'u', apiKey: 'k', model: 'm', fetch: f });
    const warn = console.warn; console.warn = () => {};
    try {
      expect(await mk(answer(500, {})).embed(['a'])).toBeNull();
      expect(await mk(answer(200, { data: [] })).embed(['a'])).toBeNull();
      expect(await mk(answer(200, { data: [{ index: 0, embedding: ['x'] }] })).embed(['a'])).toBeNull();
      expect(await mk((async () => { throw new Error('offline'); }) as unknown as typeof fetch).embed(['a'])).toBeNull();
    } finally { console.warn = warn; }
  });

  it('is off unless URL, key and model are all set', () => {
    const base = { embeddingsUrl: 'u', embeddingsApiKey: 'k', embeddingsModel: 'm', embeddingsDimensions: null };
    expect(createEmbedder(base).enabled).toBe(true);
    expect(createEmbedder({ ...base, embeddingsApiKey: null }).enabled).toBe(false);
    expect(createEmbedder({ ...base, embeddingsModel: null })).toBeInstanceOf(NoEmbedder);
  });
});

describe('findCluster with embeddings', () => {
  const ext = (title: string, lat: number, lon: number): ExtractedEvent => ({
    category: 'public_safety', severity: 3, confidence: 0.9, title, summary: '', areaName: '', lat, lon, radiusM: 500,
    startsAt: NOW.toISOString(), endsAt: null,
  });
  const existing = newEvent(ext('Brand in Wohnhaus', 52.5059, 13.4492), POLICE, 'auto', NOW);

  it('similar enough + near + same time → same event; otherwise word overlap decides', () => {
    const nearby = ext('Feuer in Mehrfamilienhaus', 52.5085, 13.4563);
    expect(findCluster(nearby, FIRE, [existing])).toBeNull(); // no shared words
    expect(findCluster(nearby, FIRE, [existing], { similarity: new Map([[existing.id, 0.86]]), minSimilarity: 0.8 })).toBe(existing);
    expect(findCluster(nearby, FIRE, [existing], { similarity: new Map([[existing.id, 0.7]]), minSimilarity: 0.8 })).toBeNull();
    // Event without a stored vector (map has no entry): word overlap.
    expect(findCluster(ext('Brand in Wohnhaus gelöscht', 52.5085, 13.4563), FIRE, [existing], { similarity: new Map(), minSimilarity: 0.8 })).toBe(existing);
  });

  it('never merges across distance, category or time, however similar the text', () => {
    const sim = { similarity: new Map([[existing.id, 0.99]]), minSimilarity: 0.8 };
    expect(findCluster(ext('Feuer', 52.55, 13.40), FIRE, [existing], sim)).toBeNull(); // ~6 km away
    expect(findCluster({ ...ext('Feuer', 52.5085, 13.4563), category: 'transit' }, FIRE, [existing], sim)).toBeNull();
    expect(findCluster({ ...ext('Feuer', 52.5085, 13.4563), startsAt: new Date(NOW.getTime() + 7 * 3600_000).toISOString() }, FIRE, [existing], sim)).toBeNull();
  });
});

describe.each(storeBackends())('dedup through the pipeline ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });
  const pipeline = (embedder?: Embedder) =>
    new Pipeline({ store, llm: new ExtractionLLM(), geocoder, embedder, push: new MemoryPushSender(), config: cfg, now: () => NOW });

  it('merges a police and a fire brigade report of the same fire, but not a different incident nearby', async () => {
    const r = await pipeline(new FakeEmbedder(SYNONYMS)).ingest([POLICE, FIRE, BOMB]);
    expect(r.eventsCreated).toBe(2);
    expect(r.eventsUpdated).toBe(1);
    const events = await store.activeEvents(NOW);
    const fire = events.find((e) => e.sources.length === 2)!;
    expect(fire.sources.map((s) => s.sourceName).sort()).toEqual(['Berliner Feuerwehr', 'Polizei Berlin']);
    expect(events.find((e) => e !== fire)!.title).toContain('Blindgänger');
  });

  it('finds the match in a later run through the stored vectors', async () => {
    const embedder = new FakeEmbedder(SYNONYMS);
    await pipeline(embedder).ingest([POLICE]);
    const r = await pipeline(embedder).ingest([FIRE]);
    expect(r.eventsCreated).toBe(0);
    expect(r.eventsUpdated).toBe(1);
  });

  it('without a provider, falls back to word overlap (which keeps these two reports apart)', async () => {
    expect((await pipeline().ingest([POLICE, FIRE])).eventsCreated).toBe(2);
  });

  it('when the provider fails, falls back to word overlap and stores nothing', async () => {
    const failing = new FailingEmbedder();
    const r = await pipeline(failing).ingest([POLICE, FIRE]);
    expect(failing.calls).toBe(2);
    expect(r.eventsCreated).toBe(2);
    const ids = (await store.activeEvents(NOW)).map((e) => e.id);
    expect((await store.eventSimilarities(ids, 'down', [1])).size).toBe(0);
  });

  it('does not embed NWS alerts (they only merge by reference)', async () => {
    const embedder = new FakeEmbedder(SYNONYMS);
    await pipeline(embedder).ingest([{
      source: 'nws', sourceName: 'NWS', externalId: 'urn:x', official: true, language: 'en', title: 'Wind Advisory', body: 'Gusts.',
      publishedAt: NOW.toISOString(), lat: 37.6, lon: -122.4, radiusM: 20_000, officialSeverity: 3, category: 'weather',
    }]);
    expect(embedder.calls).toBe(0);
  });
});
