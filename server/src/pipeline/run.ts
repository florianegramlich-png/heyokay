import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type { Geocoder } from '../geocode.js';
import type { StructuredLLM } from '../llm.js';
import type { PushSender } from '../push.js';
import type { Alert, AlertKind, Category, RiskEvent, Severity, SourceItem, User } from '../types.js';
import { extract } from './extract.js';
import { DEFAULT_EMBEDDING_MIN_SIMILARITY, findCluster, mergeInto, newEvent, type EmbeddingMatch } from './cluster.js';
import { embeddingText, type Embedder } from '../embeddings.js';
import { compose } from './compose.js';
import { decide, inQuietHours, match } from './rank.js';
import { LIFECYCLE, recommendedAction } from './guidance.js';

export interface PipelineDeps {
  store: Store;
  llm: StructuredLLM;
  geocoder: Geocoder;
  push: PushSender;
  config: Pick<Config, 'matchBufferM' | 'reviewConfidence' | 'reviewSeverity'> & Partial<Pick<Config, 'embeddingsMinSimilarity'>>;
  /** Dedup embeddings. Missing or disabled = word overlap only. */
  embedder?: Embedder;
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
  /** Updates (downgrades, new end times) and all-clears sent to people who already had the alert. */
  updates: number;
  allClears: number;
}

/** What happened to an event during one ingest run, strongest first. */
type Outcome = 'all_clear' | 'escalated' | 'changed' | 'touched';
const RANK: Record<Outcome, number> = { all_clear: 3, escalated: 2, changed: 1, touched: 0 };

/**
 * Ingest → extract → cluster → review gate → compose + verify → match → rank → dispatch.
 * PRD Section 6.2.
 */
export class Pipeline {
  constructor(private d: PipelineDeps) {}
  private now() { return this.d.now?.() ?? new Date(); }

  async ingest(items: SourceItem[], defaultArea?: { name: string; lat: number; lon: number; radiusM: number }): Promise<IngestReport> {
    const r: IngestReport = { received: items.length, new: 0, ignored: 0, eventsCreated: 0, eventsUpdated: 0, sentToReview: 0, alertsCreated: 0, pushes: 0, updates: 0, allClears: 0 };
    const touched = new Map<string, RiskEvent>();
    const outcome = new Map<string, Outcome>();
    const note = (id: string, o: Outcome) => { if (RANK[o] >= RANK[outcome.get(id) ?? 'touched']) outcome.set(id, o); };

    for (const item of items) {
      if (!await this.d.store.recordSourceItem(item)) continue; // seen before
      r.new++;
      const ext = await extract(item, { llm: this.d.llm, geocoder: this.d.geocoder, now: this.now(), defaultArea });
      if (!ext || ext.lat == null || ext.lon == null) { r.ignored++; continue; }

      const active = [...(await this.d.store.activeEvents(this.now())), ...touched.values()].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
      // An update names the message it replaces; find that event even if it started days ago.
      const referencedId = item.references?.length ? await this.d.store.eventIdForSourceRefs(item.source, item.references) : null;
      const referenced = referencedId ? (touched.get(referencedId) ?? await this.d.store.getEvent(referencedId)) : null;
      const byReference = referenced && referenced.status !== 'rejected' ? referenced : null;
      // Embedding for dedup. Not for NWS (it never fuzzy-merges) or reports already tied to an event by id.
      const embedder = this.d.embedder;
      const vector = embedder?.enabled && !byReference && item.source !== 'nws'
        ? (await embedder.embed([embeddingText(ext)]))?.[0] ?? null
        : null;
      const emb: EmbeddingMatch | undefined = vector ? {
        similarity: await this.d.store.eventSimilarities(active.map((e) => e.id), embedder!.model, vector),
        minSimilarity: this.d.config.embeddingsMinSimilarity ?? DEFAULT_EMBEDDING_MIN_SIMILARITY,
      } : undefined;
      const existing = byReference ?? findCluster(ext, item, active, emb);
      let event: RiskEvent;
      if (existing) {
        event = touched.get(existing.id) ?? existing;
        const wasActive = !event.endsAt || Date.parse(event.endsAt) > this.now().getTime();
        const { escalated, changed } = mergeInto(event, ext, item, this.now());
        const endedNow = wasActive && !!event.endsAt && Date.parse(event.endsAt) <= this.now().getTime();
        note(event.id, endedNow ? 'all_clear' : escalated ? 'escalated' : changed ? 'changed' : 'touched');
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
        note(event.id, 'touched');
      }
      await this.d.store.saveEvent(event);
      await this.d.store.linkSourceItem(item, event.id);
      // A new event keeps its first report's vector; an older event without one (provider was down) gets this one.
      if (vector && !emb!.similarity.has(event.id)) await this.d.store.saveEventEmbedding(event.id, embedder!.model, vector);
      touched.set(event.id, event);
    }

    for (const event of touched.values()) {
      const o = outcome.get(event.id) ?? 'touched';
      if (o === 'all_clear') {
        const out = await this.allClear(event);
        r.allClears += out.alerts;
        r.pushes += out.pushes;
        continue;
      }
      if (o === 'changed') r.updates += (await this.sendUpdate(event)).alerts;
      // Escalations, new events, and anyone who newly falls inside a changed event's area.
      const out = await this.deliver(event);
      r.alertsCreated += out.alerts;
      r.pushes += out.pushes;
    }
    return r;
  }

  private async ensureCopy(event: RiskEvent) {
    if (event.copyTitle) return;
    const copy = await compose(event, this.d.llm);
    event.copyTitle = copy.title;
    event.copyBody = copy.body;
    event.copyAction = copy.action;
    event.copyIsTemplate = copy.isTemplate;
    await this.d.store.saveEvent(event);
  }

  private async alertFor(user: User, event: RiskEvent, kind: AlertKind, f: { title: string; body: string; action: string; delivery: Alert['delivery']; reason: string; matchedPlace?: string | null }) {
    const primary = [...event.sources].reverse().find((s) => s.official) ?? event.sources[0];
    return this.d.store.insertAlert({
      userId: user.id, eventId: event.id, eventRevision: event.revision,
      title: f.title, body: f.body, action: f.action,
      category: event.category, severity: event.severity, official: event.official,
      aiWritten: !event.copyIsTemplate,
      sourceName: primary?.sourceName ?? 'Hey-Okay', sourceUrl: primary?.url ?? null,
      lat: event.lat, lon: event.lon, radiusM: event.radiusM,
      matchedPlace: f.matchedPlace ?? null, delivery: f.delivery, reason: f.reason, kind,
    });
  }

  /**
   * The event got less severe or its end time moved: tell the people who already have it,
   * calmly, in the feed only (no push, doesn't count toward the daily limit).
   */
  async sendUpdate(event: RiskEvent): Promise<{ alerts: number }> {
    if (event.status !== 'auto' && event.status !== 'approved') return { alerts: 0 };
    await this.ensureCopy(event);
    const prefix = LIFECYCLE[event.language ?? 'de'].updatePrefix;
    let alerts = 0;
    for (const { userId } of await this.d.store.recipients(event.id)) {
      const user = await this.d.store.getUser(userId);
      if (!user) continue;
      const a = await this.alertFor(user, event, 'update', {
        title: truncateTo(`${prefix}: ${event.copyTitle}`, 50, event.copyTitle!),
        body: event.copyBody!, action: event.copyAction!, delivery: 'feed', reason: 'event changed',
      });
      if (a) alerts++;
    }
    return { alerts };
  }

  /**
   * The event ended before its announced end (cancelled, lifted, or ended at the Alert Desk):
   * an all-clear to everyone who got it. A push only for people who got a push before, and not
   * during their quiet hours. Never counts toward the daily limit.
   */
  async allClear(event: RiskEvent): Promise<{ alerts: number; pushes: number }> {
    const recipients = await this.d.store.recipients(event.id);
    if (!event.endsAt || Date.parse(event.endsAt) > this.now().getTime()) event.endsAt = this.now().toISOString();
    event.updatedAt = this.now().toISOString();
    if (!recipients.length) { await this.d.store.saveEvent(event); return { alerts: 0, pushes: 0 }; }
    event.revision += 1;
    await this.ensureCopy(event); // a cancellation may have reset the text; name the warning it lifts
    await this.d.store.saveEvent(event);

    const t = LIFECYCLE[event.language ?? 'de'];
    const what = event.copyTitle ?? event.title;
    const outbox: Array<{ token: string; alert: Alert }> = [];
    let alerts = 0;
    for (const { userId, pushed } of recipients) {
      const user = await this.d.store.getUser(userId);
      if (!user) continue;
      const quiet = !!user.prefs.quietHours && inQuietHours(this.now(), user.prefs.quietHours.start, user.prefs.quietHours.end, user.prefs.timezone);
      const push = pushed && !!user.pushToken && !quiet;
      const a = await this.alertFor(user, event, 'all_clear', {
        title: truncateTo(`${t.allClearPrefix}: ${what}`, 50, t.allClearPrefix),
        body: t.allClearBody, action: t.allClearAction,
        delivery: push ? 'push' : 'feed', reason: quiet && pushed ? 'all clear, quiet hours' : 'all clear',
      });
      if (!a) continue;
      alerts++;
      if (push) outbox.push({ token: user.pushToken!, alert: a });
    }
    const res = outbox.length ? await this.d.push.send(outbox) : { sent: 0 };
    return { alerts, pushes: res.sent };
  }

  /** Alert Desk: end an event now and send the all-clear. */
  async endEvent(eventId: string) {
    const e = await this.d.store.getEvent(eventId);
    if (!e) return null;
    return this.allClear(e);
  }

  /**
   * Some feeds (NWS) drop an alert when it is cancelled instead of announcing it. After a successful
   * poll of `feedKey`, events from that feed that are no longer listed, and that were meant to run at
   * least 15 more minutes, were lifted early: all-clear. Events running out on schedule end quietly.
   */
  async reconcileFeed(feedKey: string, listedExternalIds: Set<string>): Promise<{ ended: number; alerts: number; pushes: number }> {
    const out = { ended: 0, alerts: 0, pushes: 0 };
    const soon = this.now().getTime() + 15 * 60_000;
    const fromFeed = (await this.d.store.activeEvents(this.now(), 24 * 14)).filter((e) => e.feedKeys?.includes(feedKey));
    // An empty list while several warnings are running is far more likely a feed glitch than
    // everything being lifted at once. Don't send a wave of all-clears for it; the next poll decides.
    if (listedExternalIds.size === 0 && fromFeed.length >= 3) return out;
    for (const e of fromFeed) {
      if (e.sources.some((s) => listedExternalIds.has(s.externalId))) continue;
      if (e.endsAt && Date.parse(e.endsAt) <= soon) continue;
      out.ended++;
      const r = await this.allClear(e);
      out.alerts += r.alerts;
      out.pushes += r.pushes;
    }
    return out;
  }

  /** Write copy if needed, then create alerts for every affected user. Only for released events. */
  async deliver(event: RiskEvent, onlyUsers?: User[], backfill = false): Promise<{ alerts: number; pushes: number }> {
    if (event.status !== 'auto' && event.status !== 'approved') return { alerts: 0, pushes: 0 };
    if (event.endsAt && Date.parse(event.endsAt) <= this.now().getTime()) return { alerts: 0, pushes: 0 };

    await this.ensureCopy(event);

    const outbox: Array<{ token: string; alert: Alert }> = [];
    let alerts = 0;
    // Only users the store finds near the event (PostGIS index in production); `match` decides.
    const candidates = onlyUsers
      ? await Promise.all(onlyUsers.map(async (user) => ({ user, places: await this.d.store.places(user.id) })))
      : await this.d.store.usersNear(event, this.d.config.matchBufferM, this.now());
    for (const { user, places } of candidates) {
      const m = match(user, places, event, this.d.config.matchBufferM, this.now());
      if (!m) continue;
      const since = new Date(this.now().getTime() - 24 * 3600_000).toISOString();
      let { delivery, reason } = decide(user, event, {
        now: this.now(),
        pushesLast24h: await this.d.store.pushCountSince(user.id, since),
        feedback: await this.d.store.feedbackByCategory(user.id),
      });
      // First sync after install: show what's going on without a burst of notifications.
      if (backfill && delivery === 'push' && !(event.official && event.severity === 5)) { delivery = 'feed'; reason = 'catch-up after setup'; }

      const alert = await this.alertFor(user, event, 'new', {
        title: m.place ? truncateTo(`${m.place}: ${event.copyTitle}`, 50, event.copyTitle!) : event.copyTitle!,
        body: event.copyBody!, action: event.copyAction!, delivery, reason, matchedPlace: m.place,
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
    for (const e of await this.d.store.activeEvents(this.now())) alerts += (await this.deliver(e, [user], backfill)).alerts;
    return alerts;
  }

  // ── Alert Desk (human review) ─────────────────────────────────────────────
  async approve(eventId: string, edits?: { title?: string; body?: string; severity?: Severity }) {
    const e = await this.d.store.getEvent(eventId);
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
    await this.d.store.saveEvent(e);
    return this.deliver(e);
  }

  async reject(eventId: string) {
    const e = await this.d.store.getEvent(eventId);
    if (!e) return false;
    e.status = 'rejected';
    e.updatedAt = this.now().toISOString();
    await this.d.store.saveEvent(e);
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
    await this.d.store.recordSourceItem(item);
    const event = newEvent({
      category: input.category, severity: input.severity, confidence: 1, title: input.title, summary: input.body,
      areaName: input.areaName, lat: input.lat, lon: input.lon, radiusM: input.radiusM,
      startsAt: item.publishedAt, endsAt: input.endsAt ?? null,
    }, item, 'approved', this.now());
    event.copyTitle = input.title.slice(0, 50);
    event.copyBody = input.body.slice(0, 100);
    event.copyIsTemplate = true;
    event.copyAction = recommendedAction(event.category, event.severity, event.language);
    await this.d.store.saveEvent(event);
    const out = await this.deliver(event);
    return { eventId: event.id, ...out };
  }
}

function truncateTo(s: string, max: number, fallback: string) {
  return s.length <= max ? s : fallback;
}
