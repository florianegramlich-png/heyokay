import type { Alert } from './types.js';

/**
 * Expo Push Service: one API in front of APNs (iOS) and FCM (Android).
 * Swap for direct APNs/FCM later without changing the pipeline (PRD Decision 2).
 */
export interface PushSender {
  send(messages: Array<{ token: string; alert: Alert }>): Promise<{ sent: number; errors: number }>;
}

export class ExpoPushSender implements PushSender {
  constructor(private url: string) {}

  async send(messages: Array<{ token: string; alert: Alert }>) {
    let sent = 0, errors = 0;
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100).map(({ token, alert }) => ({
        to: token,
        title: alert.title,
        body: alert.body,
        sound: 'default',
        priority: alert.severity >= 4 ? 'high' : 'normal',
        channelId: alert.severity >= 4 ? 'urgent' : 'alerts', // channels defined in app/src/lib/notifications.ts
        // Severity 5 official warnings use iOS time-sensitive interruption; Critical Alerts need Apple's entitlement (Decision 16).
        interruptionLevel: alert.severity >= 4 ? 'time-sensitive' : 'active',
        data: { alertId: alert.id, url: `heyokay://alert/${alert.id}` },
      }));
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(batch),
        });
        const json: any = await res.json();
        for (const t of json?.data ?? []) (t.status === 'ok' ? sent++ : errors++);
      } catch (err) {
        console.warn('[push] batch failed:', (err as Error).message);
        errors += batch.length;
      }
    }
    return { sent, errors };
  }
}

/** Collects messages instead of sending — tests and the demo. */
export class MemoryPushSender implements PushSender {
  readonly outbox: Array<{ token: string; alert: Alert }> = [];
  async send(messages: Array<{ token: string; alert: Alert }>) {
    this.outbox.push(...messages);
    return { sent: messages.length, errors: 0 };
  }
}
