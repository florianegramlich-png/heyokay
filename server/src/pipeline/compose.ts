import { packFor } from '../countries.js';
import { z } from 'zod';
import type { AlertCopy, Language, RiskEvent } from '../types.js';
import type { StructuredLLM } from '../llm.js';
import { CATEGORY_LABEL_DE, CATEGORY_LABEL_EN, recommendedAction } from './guidance.js';

export const TITLE_MAX = 50;
export const BODY_MAX = 100;

const CopySchema = z.object({
  title: z.string().describe(`Max ${TITLE_MAX} characters. What and where.`),
  body: z.string().describe(`Max ${BODY_MAX} characters. The key fact people need. No advice — that is added separately.`),
});

const LANGUAGE_NAME: Record<Language, string> = { de: 'German', en: 'English' };

const system = (language: Language) => `You write lock-screen safety alerts in ${LANGUAGE_NAME[language]} for the Hey-Okay app.
Hard rules:
- Use ONLY facts in FACTS. Every number, time, date, temperature and place must appear in FACTS.
- Title ≤ ${TITLE_MAX} characters: what and where. Body ≤ ${BODY_MAX} characters: the single most useful fact.
- Plain, calm language. No exclamation marks, no speculation, no causes not stated.
- Never describe an area or neighbourhood as dangerous. Report the event only.
- No personal details about any person involved.`;

/** Write and verify alert copy for an event. Falls back to a template built from source text. */
export async function compose(event: RiskEvent, llm: StructuredLLM): Promise<AlertCopy & { isTemplate: boolean }> {
  const language = event.language ?? 'de';
  const action = recommendedAction(event.category, event.severity, language, event.hazard, packFor(event));
  if (llm.enabled) {
    let feedback = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await llm.generate(
        system(language),
        `Category: ${event.category}\nSeverity (1-5): ${event.severity}\nArea: ${event.areaName}\n\nFACTS:\n${event.facts.slice(0, 6000)}${feedback}`,
        CopySchema,
      );
      if (!out) break;
      const problems = verify(out, event.facts);
      if (problems.length === 0) return { title: out.title.trim(), body: out.body.trim(), action, isTemplate: false };
      feedback = `\n\nYour previous attempt was rejected: ${problems.join('; ')}. Fix these.`;
    }
  }
  return { ...template(event), action, isTemplate: true };
}

/** Deterministic copy from verbatim source text — always grounded. */
/** "WARNUNG vor STURMBÖEN" → "Warnung vor Sturmböen": DWD writes the warning type in capitals. */
export function sentenceCase(s: string): string {
  return s.replace(/\p{Lu}{2,}[\p{Lu}\p{Ll}]*/gu, (w) => (w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w));
}

export function template(event: RiskEvent): { title: string; body: string } {
  // The latest official message describes the current state (an update may carry a new end time).
  const src = [...event.sources].reverse().find((s) => s.official) ?? event.sources[0];
  const label = (event.language === 'en' ? CATEGORY_LABEL_EN : CATEGORY_LABEL_DE)[event.category];
  const srcTitle = src?.title || event.title;
  // Heat from a forecast: our own grounded text already says what and how hot ("Hitze: bis 36 °C gefühlt").
  if (event.hazard === 'heat' || event.hazard === 'outage') return { title: truncate(srcTitle, TITLE_MAX), body: truncate(event.summary || srcTitle, BODY_MAX) };
  // NWS lists several forecast zones ("San Francisco; Coastal North Bay; …"). Naming only the first
  // would mislead people in the others, so name the warning instead: "Weather: Wind Advisory".
  if (event.areaName.includes(';')) {
    const what = srcTitle.split(/\s+(?:until|from|for)\s+/i)[0];
    return { title: truncate(`${label}: ${what}`, TITLE_MAX), body: truncate(srcTitle, BODY_MAX) };
  }
  // Same for NINA/DWD warnings over several municipalities ("Gemeinde Bodensee, Stadt Bad Sachsa, …"):
  // someone in Berlin must not read "Wetter: Gemeinde Bodensee". Name the warning, in calm sentence case.
  if (event.areaName.includes(',') && event.official) {
    const what = sentenceCase(srcTitle.replace(/^amtliche\s+/i, ''));
    return { title: truncate(`${label}: ${what}`, TITLE_MAX), body: truncate(srcTitle, BODY_MAX) };
  }
  const area = event.areaName.split(',')[0].trim();
  const title = truncate(`${label}${area ? `: ${area}` : ''}`, TITLE_MAX);
  const body = truncate(srcTitle, BODY_MAX);
  return { title, body };
}

const ALARM_STEMS = [
  'lebensgefahr', 'evakuier', 'explosion', 'tote', 'getötet', 'verletzt', 'schüsse', 'geschossen', 'bombe', 'amok', 'terror', 'geiselnahme', 'brand', 'feuer',
  'life-threatening', 'evacuat', 'killed', 'injur', 'shooting', 'shots', 'gunfire', 'bomb', 'hostage', 'fire',
];
const AREA_STIGMA = /\b(gefährlich\w*|unsicher\w*|kriminell\w*)\s+(viertel|kiez|gegend|stadtteil|bezirk|ecke)\b|\b(problemviertel|brennpunkt)\b|\b(dangerous|unsafe|crime-ridden|sketchy)\s+(neighbou?rhood|area|part of town|district|block)\b/i;

/**
 * The fact verifier. Returns a list of problems; empty = safe to send.
 * - length limits (Apple/Google lock-screen limits)
 * - every number/time/date in the copy must appear in the source facts
 * - alarm words must be grounded in the facts (no invented escalation)
 * - no area stigma wording
 */
export function verify(copy: { title: string; body: string }, facts: string): string[] {
  const problems: string[] = [];
  if (copy.title.length > TITLE_MAX) problems.push(`title is ${copy.title.length} chars (max ${TITLE_MAX})`);
  if (copy.body.length > BODY_MAX) problems.push(`body is ${copy.body.length} chars (max ${BODY_MAX})`);
  if (!copy.title.trim() || !copy.body.trim()) problems.push('empty title or body');

  const text = `${copy.title} ${copy.body}`;
  const factNumbers = new Set(numbers(facts));
  for (const n of numbers(text)) if (!factNumbers.has(n)) problems.push(`"${n}" is not in the source`);

  const lowerFacts = facts.toLowerCase();
  const lowerText = text.toLowerCase();
  for (const stem of ALARM_STEMS) {
    if (lowerText.includes(stem) && !lowerFacts.includes(stem)) problems.push(`"${stem}…" is not in the source`);
  }
  if (AREA_STIGMA.test(text)) problems.push('describes an area as dangerous');
  return [...new Set(problems)];
}

/** Normalised numeric tokens: 18:30 → "18:30", 3,5 → "3.5", 34 °C → "34". */
export function numbers(s: string): string[] {
  return [...s.matchAll(/\d+(?:[.,:]\d+)*/g)].map((m) => m[0].replace(',', '.').replace(/^0+(?=\d)/, ''));
}

export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}
