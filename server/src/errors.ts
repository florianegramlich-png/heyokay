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

export function errorEntry(context: string, err: unknown, extra: Record<string, unknown> = {}, level: ErrorLogEntry['level'] = 'error'): ErrorLogEntry {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  return { ...extra, level, time: new Date().toISOString(), context, name: e.name, message: e.message, stack: e.stack };
}

export function logError(context: string, err: unknown, extra: Record<string, unknown> = {}, sink: ErrorSink = stderrSink) {
  sink(errorEntry(context, err, extra));
}

/**
 * Log unhandled promise rejections (and keep running) and uncaught exceptions (then exit, since
 * the process state is unknown and the host restarts it). Returns a function that removes the handlers.
 */
type ProcessLike = Pick<NodeJS.Process, 'on' | 'off'>;

export function installProcessHandlers(
  sink: ErrorSink = stderrSink,
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
