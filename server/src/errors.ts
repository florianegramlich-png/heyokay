import { randomUUID } from 'node:crypto';
import { M } from './metrics.js';
// Server-side crash reporting (PRD 5.3, 13): every unexpected error becomes one structured JSON
// line on stderr, so the host's log drain (Fly/stdout) can alert on `"level":"error"`.
// Never logs request bodies, query strings, headers or tokens — only method, route and the error.

export interface ErrorLogEntry {
  level: 'error' | 'fatal';
  time: string;
  context: string;
  name: string;
  message: string;
  stack?: string;
  [key: string]: unknown;
}

export type ErrorSink = (entry: ErrorLogEntry) => void;

export const stderrSink: ErrorSink = (entry) => {
  process.stderr.write(JSON.stringify(entry) + '\n');
};

let sinks: ErrorSink[] = [stderrSink];
/** Where errors go by default: stderr, plus Sentry when SENTRY_DSN is set (index.ts). */
export function setErrorSinks(...s: ErrorSink[]) { sinks = s; }
export const defaultSink: ErrorSink = (entry) => {
  M.errors.inc({ context: entry.context });
  for (const s of sinks) { try { s(entry); } catch { /* a broken sink must never break the caller */ } }
};

/**
 * Sentry (EU region, e.g. https://<key>@o0.ingest.de.sentry.io/<project>) via its envelope API,
 * without the SDK. Only what the entry already holds (context, error, route) is sent; at most
 * `perMinute` events, so an error storm can't flood the quota. Fire and forget.
 */
export function sentrySink(dsn: string, opts: { environment?: string; release?: string; perMinute?: number; fetch?: typeof fetch; now?: () => number } = {}): ErrorSink {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\//, '');
  const url = `${u.protocol}//${u.host}/api/${projectId}/envelope/`;
  const auth = `Sentry sentry_version=7, sentry_client=heyokay/1.0, sentry_key=${u.username}`;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let windowStart = 0, sent = 0;
  return (entry) => {
    const t = now();
    if (t - windowStart > 60_000) { windowStart = t; sent = 0; }
    if (sent >= (opts.perMinute ?? 30)) return;
    sent++;
    const eventId = randomUUID().replace(/-/g, '');
    const { level, time, context, name, message, stack, ...extra } = entry;
    const event = {
      event_id: eventId, timestamp: time, platform: 'node', level: level === 'fatal' ? 'fatal' : 'error',
      environment: opts.environment ?? 'production', ...(opts.release ? { release: opts.release } : {}),
      tags: { context }, extra,
      exception: { values: [{ type: name, value: message, ...(stack ? { stacktrace: { frames: parseStack(stack) } } : {}) }] },
    };
    const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date(t).toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
    doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': auth }, body, signal: AbortSignal.timeout(5000) })
      .catch(() => {});
  };
}

/** Node stack lines → Sentry frames (oldest first, as Sentry expects). */
export function parseStack(stack: string) {
  return stack.split('\n').slice(1).map((l) => l.trim().match(/^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/)).filter(Boolean)
    .map((m) => ({ function: m![1] ?? '?', filename: m![2], lineno: Number(m![3]), colno: Number(m![4]), in_app: !m![2].includes('node_modules') && !m![2].startsWith('node:') }))
    .reverse();
}

export function errorEntry(context: string, err: unknown, extra: Record<string, unknown> = {}, level: ErrorLogEntry['level'] = 'error'): ErrorLogEntry {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  return { ...extra, level, time: new Date().toISOString(), context, name: e.name, message: e.message, stack: e.stack };
}

export function logError(context: string, err: unknown, extra: Record<string, unknown> = {}, sink: ErrorSink = defaultSink) {
  sink(errorEntry(context, err, extra));
}

/**
 * Log unhandled promise rejections (and keep running) and uncaught exceptions (then exit, since
 * the process state is unknown and the host restarts it). Returns a function that removes the handlers.
 */
type ProcessLike = Pick<NodeJS.Process, 'on' | 'off'>;

export function installProcessHandlers(
  sink: ErrorSink = defaultSink,
  exit: (code: number) => void = (c) => process.exit(c),
  proc: ProcessLike = process,
) {
  const onRejection = (reason: unknown) => sink(errorEntry('unhandledRejection', reason));
  const onException = (err: Error) => {
    sink(errorEntry('uncaughtException', err, {}, 'fatal'));
    exit(1);
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}
