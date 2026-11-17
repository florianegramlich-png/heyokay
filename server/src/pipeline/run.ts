import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Geocoder } from '../geocode.js';
import type { StructuredLLM } from '../llm.js';
import type { PushSender } from '../push.js';
import type { Alert, Category, RiskEvent, Severity, SourceItem, User } from '../types.js';
import { extract } from './extract.js';
import { findCluster, mergeInto, newEvent } from './cluster.js';
import { compose } from './compose.js';
import { decide, match } from './rank.js';
import { recommendedAction } from './guidance.js';

export interface PipelineDeps {
  store: Store;
  llm: StructuredLLM;
  geocoder: Geocoder;
  push: PushSender;
  config: Pick<Config, 'matchBufferM' | 'reviewConfidence' | 'reviewSeverity'>;
  now?: () => Date;
}

export interface IngestReport {
  received: number;
  new: number;
  ignored: number;
  eventsCreated: number;
  eventsUpdated: number;
  sentToReview: number;
  alertsCreated: number;
  pushes: number;
}

/**
 * Ingest → extract → cluster → review gate → compose + verify → match → rank → dispatch.
 * PRD Section 6.2.
 */
export class Pipeline {
  constructor(private d: PipelineDeps) {}
  private now() { return this.d.now?.() ?? new Date(); }

  async ingest(items: SourceItem[], defaultArea?: { name: string; lat: number; lon: number; radiusM: number }): Promise<IngestReport> {
    const r: IngestReport = { received: items.length, new: 0, ignored: 0, eventsCreated: 0, eventsUpdated: 0, sentToReview: 0, alertsCreated: 0, pushes: 0 };
    const touched = new Map<string, RiskEvent>();

    for (const item of items) {
      if (!this.d.store.recordSourceItem(item)) continue; // seen before
      r.new++;
      const ext = await extract(item, { llm: this.d.llm, geocoder: this.d.geocoder, now: this.now(), defaultArea });
      if (!ext || ext.lat == null || ext.lon == null) { r.ignored++; continue; }

      const active = [...this.d.store.activeEvents(this.now()), ...touched.values()].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
      const existing = findCluster(ext, item, active);
      let event: RiskEvent;
      if (existing) {
        event = touched.get(existing.id) ?? existing;
        const { escalated } = mergeInto(event, ext, item, this.now());
        if (escalated && !event.official && event.severity >= this.d.config.reviewSeverity && event.status !== 'pending_review') {
          event.status = 'pending_review';
          r.sentToReview++;
        }
        r.eventsUpdated++;
      } else {
        const needsReview = !item.official &&
          (ext.confidence < this.d.config.reviewConfidence || ext.severity >= this.d.config.reviewSeverity);
        event = newEvent(ext, item, needsReview ? 'pending_review' : 'auto', this.now());
        if (needsReview) r.sentToReview++;
        r.eventsCreated++;
      }
      this.d.store.saveEvent(event);
      this.d.store.linkSourceItem(item, event.id);
      touched.set(event.id, event);
    }

    for (const event of touched.values()) {
      const out = await this.deliver(event);
      r.alertsCreated += out.alerts;
      r.pushes += out.pushes;
    }
    return r;
  }

  /** Write copy if needed, then create alerts for every affected user. Only for released events. */
  async deliver(event: RiskEvent, onlyUsers?: User[], backfill = false): Promise<{ alerts: number; pushes: number }> {
    if (event.status !== 'auto' && event.status !== 'approved') return { alerts: 0, pushes: 0 };
    if (event.endsAt && Date.parse(event.endsAt) <= this.now().getTime()) return { alerts: 0, pushes: 0 };

    if (!event.copyTitle) {
      const copy = await compose(event, this.d.llm);
      event.copyTitle = copy.title;
      event.copyBody = copy.body;
      event.copyAction = copy.action;
      event.copyIsTemplate = copy.isTemplate;
      this.d.store.saveEvent(event);
    }

    const outbox: Array<{ token: string; alert: Alert }> = [];
    let alerts = 0;
    for (const user of onlyUsers ?? this.d.store.allUsers()) {
      const m = match(user, this.d.store.places(user.id), event, this.d.config.matchBufferM, this.now());
      if (!m) continue;
      const since = new Date(this.now().getTime() - 24 * 3600_000).toISOString();
      let { delivery, reason } = decide(user, event, {
        now: this.now(),
        pushesLast24h: this.d.store.pushCountSince(user.id, since),
        feedback: this.d.store.feedbackByCategory(user.id),
      });
      // First sync after install: show what's going on without a burst of notifications.
      if (backfill && delivery === 'push' && !(event.official && event.severity === 5)) { delivery = 'feed'; reason = 'catch-up after setup'; }

      const primary = event.sources.find((s) => s.official) ?? event.sources[0];
      const alert = this.d.store.insertAlert({
        userId: user.id, eventId: event.id, eventRevision: event.revision,
        title: m.place ? truncateTo(`${m.place}: ${event.copyTitle}`, 50, event.copyTitle!) : event.copyTitle!,
        body: event.copyBody!, action: event.copyAction!,
        category: event.category, severity: event.severity, official: event.official,
        aiWritten: !event.copyIsTemplate,
        sourceName: primary?.sourceName ?? 'Hey-Okay', sourceUrl: primary?.url ?? null,
        lat: event.lat, lon: event.lon, radiusM: event.radiusM,
        matchedPlace: m.place, delivery, reason,
      });
      if (!alert) continue; // already alerted for this revision
      alerts++;
      if (delivery === 'push' && user.pushToken) outbox.push({ token: user.pushToken, alert });
    }
    const res = outbox.length ? await this.d.push.send(outbox) : { sent: 0 };
    return { alerts, pushes: res.sent };
  }

  /** New location or new saved place: check currently active events for this user. */
  async refreshUser(user: User, backfill = false) {
    let alerts = 0;
    for (const e of this.d.store.activeEvents(this.now())) alerts += (await this.deliver(e, [user], backfill)).alerts;
    return alerts;
  }

  // ── Alert Desk (human review) ─────────────────────────────────────────────
  async approve(eventId: string, edits?: { title?: string; body?: string; severity?: Severity }) {
    const e = this.d.store.getEvent(eventId);
    if (!e) return null;
    e.status = 'approved';
    if (edits?.severity && edits.severity !== e.severity) {
      e.severity = edits.severity;
      e.copyTitle = e.copyBody = e.copyAction = null;
    }
    if ((edits?.title || edits?.body) && !e.copyTitle) {
      // Write the AI copy first, so the reviewer's edits override it rather than being overwritten.
      const copy = await compose(e, this.d.llm);
      e.copyTitle = copy.title; e.copyBody = copy.body; e.copyAction = copy.action; e.copyIsTemplate = copy.isTemplate;
    }
    if (edits?.title) { e.copyTitle = edits.title.slice(0, 50); e.copyIsTemplate = true; }
    if (edits?.body) { e.copyBody = edits.body.slice(0, 100); e.copyIsTemplate = true; }
    e.updatedAt = this.now().toISOString();
    this.d.store.saveEvent(e);
    return this.deliver(e);
  }

  reject(eventId: string) {
    const e = this.d.store.getEvent(eventId);
    if (!e) return false;
    e.status = 'rejected';
    e.updatedAt = this.now().toISOString();
    this.d.store.saveEvent(e);
    return true;
  }

  /** Concierge pilot: a human-curated alert. Goes straight out (a person wrote it). */
  async manualAlert(input: {
    category: Category; severity: Severity; title: string; body: string; sourceName: string; sourceUrl?: string;
    lat: number; lon: number; radiusM: number; areaName: string; endsAt?: string; language?: 'de' | 'en';
  }) {
    const item: SourceItem = {
      source: 'manual', sourceName: input.sourceName, externalId: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      official: false, title: input.title, body: input.body, url: input.sourceUrl, publishedAt: this.now().toISOString(),
      lat: input.lat, lon: input.lon, radiusM: input.radiusM, category: input.category, areaName: input.areaName,
      language: input.language ?? 'de',
    };
    this.d.store.recordSourceItem(item);
    const event = newEvent({
      category: input.category, severity: input.severity, confidence: 1, title: input.title, summary: input.body,
      areaName: input.areaName, lat: input.lat, lon: input.lon, radiusM: input.radiusM,
      startsAt: item.publishedAt, endsAt: input.endsAt ?? null,
    }, item, 'approved', this.now());
    event.copyTitle = input.title.slice(0, 50);
    event.copyBody = input.body.slice(0, 100);
    event.copyIsTemplate = true;
    event.copyAction = recommendedAction(event.category, event.severity, event.language);
    this.d.store.saveEvent(event);
    const out = await this.deliver(event);
    return { eventId: event.id, ...out };
  }
}

function truncateTo(s: string, max: number, fallback: string) {
  return s.length <= max ? s : fallback;
}
