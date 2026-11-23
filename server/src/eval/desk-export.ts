import type { RiskEvent } from '../types.js';
import type { EvalCaseInput } from './cases.js';

/**
 * Alert Desk reviews as new eval labels (PRD 6.4, 6.5). Every event a person approved (with the
 * severity they chose) or rejected becomes a case in the `server/eval/cases/` format, with the
 * first source's text as the input. Hand-written concierge alerts are left out (no source to
 * extract from), and so are official warnings (they never reach the desk).
 *
 * The text is the publisher's press release. Before a file goes into the repository, someone
 * reads it for names and other personal details and removes them (see server/eval/README.md).
 */
export interface DeskCaseFile {
  name: string;
  description: string;
  cases: EvalCaseInput[];
}

/** First source's text from the event's facts: "title\nbody[\narea]", sources split by "\n---\n". */
export function firstSourceText(e: RiskEvent): { title: string; body: string } {
  const first = e.facts.split('\n---\n')[0] ?? '';
  const [title = '', ...rest] = first.split('\n');
  const body = rest.join('\n').trim();
  return { title: title.trim() || e.sources[0]?.title || e.title, body };
}

export function isDeskReviewed(e: RiskEvent): boolean {
  if (e.status !== 'approved' && e.status !== 'rejected') return false;
  if (e.official) return false;
  return !e.sources.some((s) => s.externalId.startsWith('manual:'));
}

export function deskCases(events: RiskEvent[], opts: { since?: string; now?: Date } = {}): DeskCaseFile {
  const since = opts.since ? Date.parse(opts.since) : null;
  const picked = events
    .filter(isDeskReviewed)
    .filter((e) => since == null || Date.parse(e.updatedAt) >= since)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  const cases: EvalCaseInput[] = picked.map((e) => {
    const { title, body } = firstSourceText(e);
    return {
      id: `desk-${e.id}`,
      item: { sourceName: e.sources[0]?.sourceName ?? 'Alert Desk', title, body, publishedAt: e.startsAt, language: e.language ?? 'de' },
      expect: e.status === 'approved' ? { isEvent: true, category: e.category, severity: e.severity } : { isEvent: false },
      origin: 'desk',
    };
  });
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
  return {
    name: `Alert Desk reviews (exported ${day})`,
    description: 'Approved (with the reviewer\'s severity) and rejected events from the Alert Desk. Remove names and personal details before committing.',
    cases,
  };
}
