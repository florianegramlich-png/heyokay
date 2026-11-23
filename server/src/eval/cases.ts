import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CATEGORIES, type SourceItem } from '../types.js';
import type { RssFeedConfig } from '../config.js';
import { parseFeed } from '../sources/rss.js';
import { AREA, parseAgencyFeed } from '../sources/presseportal.js';

/**
 * Labelled cases for the AI evaluation harness (PRD 6.4, 6.5). One JSON file per set in
 * `server/eval/cases/`. A case is either written out (`item`) or points at an item in a saved
 * feed under `test/fixtures` (`fixture`), so real press releases aren't copied twice.
 *
 * `expect.category` may list several answers when more than one is right (a closed street for a
 * gas leak is infrastructure or public safety). Severity uses the scale in pipeline/extract.ts.
 */
const Category = z.enum(CATEGORIES);

export const ExpectSchema = z.object({
  isEvent: z.boolean(),
  category: z.union([Category, z.array(Category).min(1)]).optional(),
  severity: z.number().int().min(1).max(5).optional(),
}).refine((e) => !e.isEvent || (e.category != null && e.severity != null), 'an event needs a category and a severity');

const ItemSchema = z.object({
  sourceName: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  publishedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date'),
  category: Category.optional(),
  language: z.enum(['de', 'en']).optional(),
});

export const CaseSchema = z.object({
  id: z.string().min(1),
  item: ItemSchema.optional(),
  fixture: z.object({ file: z.string(), format: z.enum(['rss', 'presseportal']), index: z.number().int().min(0) }).optional(),
  /** Feed-level hints for fixture cases (what the source adapter would add). */
  sourceName: z.string().optional(),
  category: Category.optional(),
  /** City the source covers (presseportal AREA key), used when the text names no known place. */
  defaultArea: z.string().optional(),
  expect: ExpectSchema,
  /** Where the label came from: written by hand, or exported from the Alert Desk. */
  origin: z.enum(['synthetic', 'fixture', 'desk']).optional(),
}).refine((c) => !!c.item !== !!c.fixture, 'a case has either item or fixture');

export const CaseFileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  cases: z.array(CaseSchema),
});

export type EvalCaseInput = z.infer<typeof CaseSchema>;
export type Expectation = z.infer<typeof ExpectSchema>;

/** A case ready to run: the source item as the pipeline would see it. */
export interface EvalCase {
  id: string;
  set: string;
  item: SourceItem;
  defaultArea?: { name: string; lat: number; lon: number; radiusM: number };
  expect: Expectation;
}

export function resolveCase(c: EvalCaseInput, set: string, fixturesDir: string): EvalCase {
  let item: SourceItem;
  if (c.item) {
    item = {
      source: 'rss', sourceName: c.item.sourceName, externalId: `eval:${c.id}`, official: false,
      title: c.item.title, body: c.item.body, publishedAt: new Date(c.item.publishedAt).toISOString(),
      category: c.item.category ?? c.category, language: c.item.language ?? 'de',
    };
  } else {
    const f = c.fixture!;
    const xml = readFileSync(join(fixturesDir, f.file), 'utf8');
    const sourceName = c.sourceName ?? f.file;
    if (f.format === 'rss') {
      const parsed = parseFeed(xml, { url: 'fixture', sourceName, categoryHint: c.category as RssFeedConfig['categoryHint'] })[f.index];
      if (!parsed) throw new Error(`${set}/${c.id}: ${f.file} has no item ${f.index}`);
      item = { ...parsed, externalId: `eval:${c.id}` };
    } else {
      const e = parseAgencyFeed(xml)[f.index];
      if (!e) throw new Error(`${set}/${c.id}: ${f.file} has no item ${f.index}`);
      item = {
        source: 'presseportal', sourceName, externalId: `eval:${c.id}`, official: false,
        title: e.title, body: e.teaser, url: e.url, publishedAt: e.publishedAt, category: c.category, language: 'de',
      };
    }
  }
  let defaultArea: EvalCase['defaultArea'];
  if (c.defaultArea) {
    const a = (AREA as Record<string, { name: string; lat: number; lon: number; radiusM: number }>)[c.defaultArea];
    if (!a) throw new Error(`${set}/${c.id}: unknown defaultArea "${c.defaultArea}"`);
    defaultArea = { ...a };
  }
  return { id: c.id, set, item, defaultArea, expect: c.expect };
}

/** Every case file in `dir` (sorted by name), validated and resolved. Duplicate ids are an error. */
export function loadCases(dir: string, fixturesDir: string): EvalCase[] {
  const out: EvalCase[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = CaseFileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const set = file.replace(/\.json$/, '');
    for (const c of parsed.data.cases) {
      if (seen.has(c.id)) throw new Error(`${file}: duplicate case id "${c.id}"`);
      seen.add(c.id);
      out.push(resolveCase(c, set, fixturesDir));
    }
  }
  return out;
}
