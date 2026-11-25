import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Decision } from './types.js';
import { logError } from './errors.js';

/**
 * Decision log (PRD 6.3, EU AI Act): writes one row per pipeline step and Alert Desk action.
 * Best effort: a failed write is logged and never stops an alert.
 */
export class DecisionLog {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  async record(d: Omit<Decision, 'id' | 'at' | 'actor' | 'model' | 'promptVersion' | 'sourceRef' | 'eventId'> & Partial<Pick<Decision, 'actor' | 'model' | 'promptVersion' | 'sourceRef' | 'eventId'>>): Promise<void> {
    const row: Decision = {
      id: randomUUID(), at: this.now().toISOString(), actor: 'pipeline', eventId: null, sourceRef: null, model: null, promptVersion: null, ...d,
    };
    try {
      await this.store.recordDecision(row);
    } catch (err) {
      logError('decisions', err as Error, { kind: d.kind });
    }
  }
}

const CSV_COLUMNS = ['at', 'kind', 'actor', 'outcome', 'eventId', 'sourceRef', 'model', 'promptVersion', 'detail'] as const;

/** RFC 4180: quote every field; a field starting with = + - @ gets a leading ' so spreadsheets don't run it. */
function cell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function decisionsCsv(rows: Decision[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const d of rows) lines.push(CSV_COLUMNS.map((c) => cell(d[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
