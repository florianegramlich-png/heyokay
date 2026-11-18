/**
 * Every outbound request gets a deadline. Without one, a source that answers slowly (or a host
 * that tarpits our IP) holds an ingest cycle for minutes per request: Node's fetch only gives up
 * after 5 minutes without headers.
 */
export const SOURCE_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = SOURCE_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}
