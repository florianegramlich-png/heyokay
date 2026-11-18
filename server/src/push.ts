import type { Alert } from './types.js';
import { fetchWithTimeout } from './http.js';

/**
 * Expo Push Service: one API in front of APNs (iOS) and FCM (Android).
 * Swap for direct APNs/FCM later without changing the pipeline (PRD Decision 2).
 *
 * Sending returns one ticket per message. A ticket only means Expo accepted the message; whether
 * Apple/Google delivered it is in the receipt, fetched about 15 minutes later (`getReceipts`).
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */
export interface PushMessage { token: string; alert: Alert }

export interface PushTicket {
  alertId: string;
  userId: string;
  token: string;
  /** Expo's ticket id, to fetch the receipt; null when the message was refused right away. */
  ticketId: string | null;
  status: 'pending' | 'error';
  /** Expo error code, e.g. DeviceNotRegistered, MessageRateExceeded. */
  error: string | null;
}

export interface PushResult { sent: number; errors: number; tickets: PushTicket[] }

export type ReceiptResult = { status: 'ok' } | { status: 'error'; error: string };

export interface PushSender {
  send(messages: PushMessage[]): Promise<PushResult>;
  /** Receipts for ticket ids; ids Expo doesn't know yet are missing from the map. */
  getReceipts(ticketIds: string[]): Promise<Map<string, ReceiptResult>>;
}

/** Errors worth trying again later; everything else is final. */
export const TRANSIENT_PUSH_ERRORS = new Set(['MessageRateExceeded', 'ExpoError', 'ProviderError']);

/** The Expo push payload: category for the "Relevant / Nicht relevant" buttons, thread to group per event. */
export function toExpoMessage({ token, alert }: PushMessage) {
  return {
    to: token,
    title: alert.title,
    body: alert.body,
    sound: 'default',
    priority: alert.severity >= 4 ? 'high' : 'normal',
    channelId: alert.severity >= 4 ? 'urgent' : 'alerts', // channels defined in app/src/lib/notifications.ts
    // Severity 5 official warnings use iOS time-sensitive interruption; Critical Alerts need Apple's entitlement (Decision 16).
    interruptionLevel: alert.severity >= 4 ? 'time-sensitive' : 'active',
    // Buttons defined in app/src/lib/notifications.ts (setNotificationCategoryAsync). All-clears need no rating.
    ...(alert.kind === 'all_clear' ? {} : { categoryId: 'alert' }),
    // One stack per incident: the warning, its updates and the all-clear group together.
    threadId: alert.eventId,
    data: { alertId: alert.id, eventId: alert.eventId, url: `heyokay://alert/${alert.id}` },
  };
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ExpoPushSender implements PushSender {
  constructor(
    private url: string,
    private opts: { receiptsUrl?: string; accessToken?: string | null; attempts?: number; sleep?: Sleep; fetch?: typeof fetch } = {},
  ) {}

  private get receiptsUrl() {
    return this.opts.receiptsUrl ?? this.url.replace(/\/send$/, '/getReceipts');
  }

  /** POST with retries on network errors, HTTP 429 and 5xx (1 s, 2 s, 4 s…). */
  private async post(url: string, body: unknown): Promise<any> {
    const attempts = this.opts.attempts ?? 3;
    const sleep = this.opts.sleep ?? realSleep;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(1000 * 2 ** (i - 1));
      try {
        const init: RequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', Accept: 'application/json',
            ...(this.opts.accessToken ? { Authorization: `Bearer ${this.opts.accessToken}` } : {}),
          },
          body: JSON.stringify(body),
        };
        const res = this.opts.fetch ? await this.opts.fetch(url, init) : await fetchWithTimeout(url, init);
        if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
        return await res.json();
      } catch (err) {
        if ((err as { final?: boolean }).final) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async send(messages: PushMessage[]): Promise<PushResult> {
    let sent = 0, errors = 0;
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const json = await this.post(this.url, chunk.map(toExpoMessage));
        const data: any[] = Array.isArray(json?.data) ? json.data : [];
        chunk.forEach((m, k) => {
          const t = data[k];
          const ok = t?.status === 'ok';
          ok ? sent++ : errors++;
          tickets.push({
            alertId: m.alert.id, userId: m.alert.userId, token: m.token,
            ticketId: ok ? String(t.id) : null,
            status: ok ? 'pending' : 'error',
            error: ok ? null : String(t?.details?.error ?? t?.message ?? 'unknown'),
          });
        });
      } catch (err) {
        console.warn('[push] batch failed after retries:', (err as Error).message);
        errors += chunk.length;
        for (const m of chunk) tickets.push({ alertId: m.alert.id, userId: m.alert.userId, token: m.token, ticketId: null, status: 'error', error: 'SendFailed' });
      }
    }
    return { sent, errors, tickets };
  }

  async getReceipts(ticketIds: string[]): Promise<Map<string, ReceiptResult>> {
    const out = new Map<string, ReceiptResult>();
    for (let i = 0; i < ticketIds.length; i += 1000) {
      const json = await this.post(this.receiptsUrl, { ids: ticketIds.slice(i, i + 1000) });
      for (const [id, r] of Object.entries((json?.data ?? {}) as Record<string, any>)) {
        out.set(id, r?.status === 'ok' ? { status: 'ok' } : { status: 'error', error: String(r?.details?.error ?? r?.message ?? 'unknown') });
      }
    }
    return out;
  }
}

/** Collects messages instead of sending — tests and the demo. */
export class MemoryPushSender implements PushSender {
  readonly outbox: PushMessage[] = [];
  /** Receipts to hand out, by ticket id (tests). */
  readonly receipts = new Map<string, ReceiptResult>();
  /** Per-token ticket errors to simulate (tests), e.g. DeviceNotRegistered. */
  readonly refuse = new Map<string, string>();
  private n = 0;

  async send(messages: PushMessage[]): Promise<PushResult> {
    const tickets: PushTicket[] = [];
    let sent = 0, errors = 0;
    for (const m of messages) {
      const refused = this.refuse.get(m.token);
      if (refused) { errors++; tickets.push({ alertId: m.alert.id, userId: m.alert.userId, token: m.token, ticketId: null, status: 'error', error: refused }); continue; }
      this.outbox.push(m);
      sent++;
      tickets.push({ alertId: m.alert.id, userId: m.alert.userId, token: m.token, ticketId: `t${++this.n}`, status: 'pending', error: null });
    }
    return { sent, errors, tickets };
  }

  async getReceipts(ids: string[]) {
    return new Map(ids.filter((id) => this.receipts.has(id)).map((id) => [id, this.receipts.get(id)!] as const));
  }
}
