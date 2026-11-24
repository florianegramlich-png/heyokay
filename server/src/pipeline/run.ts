import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type { Geocoder } from '../geocode.js';
import type { StructuredLLM } from '../llm.js';
import { TRANSIENT_PUSH_ERRORS, type PushMessage, type PushSender, type PushTicket } from '../push.js';
import type { Alert, AlertKind, Category, RiskEvent, Severity, SourceItem, User } from '../types.js';
import { extract, type ExtractTrace } from './extract.js';
import { DecisionLog } from '../decisions.js';
import { DEFAULT_EMBEDDING_MIN_SIMILARITY, findCluster, mergeInto, newEvent, type EmbeddingMatch } from './cluster.js';
import { embeddingText, type Embedder } from '../embeddings.js';
import { compose, type ComposeTrace } from './compose.js';
import { decide, inQuietHours, match, isAhead } from './rank.js';
import { LIFECYCLE, recommendedAction } from './guidance.js';
import { packFor } from '../countries.js';
import { digestDue, digestItems, digestPush } from './digest.js';
import { contentLanguage } from '../types.js';
import { M } from '../metrics.js';

export interface PipelineDeps {
  store: Store;
  llm: StructuredLLM;
  geocoder: Geocoder;
  push: PushSender;
  config: Pick<Config, 'matchBufferM' | 'reviewConfidence' | 'reviewSeverity'> & Partial<Pick<Config, 'embeddingsMinSimilarity'>>;
  /** Dedup embeddings. Missing or disabled = word overlap only. */
  embedder?: Embedder;
  now?: () => Date;
  /** Delivery queue: who claims jobs (machine id), sends in flight, jobs per send. */
  delivery?: { holder?: string; concurrency?: number; batch?: number };
}

/** A claimed job not finished in this time (sender died) goes back to the queue. */
export const PUSH_JOB_LOCK_MS = 5 * 60_000;

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
  private log: DecisionLog;
  constructor(private d: PipelineDeps) {
    this.log = new DecisionLog(d.store, () => this.now());
  }
  private now() { return this.d.now?.() ?? new Date(); }

  private logCompose(event: RiskEvent, t: ComposeTrace | null, actor = 'pipeline') {
    if (!t) return Promise.resolve();
    return this.log.record({
      kind: 'compose', actor, eventId: event.id, model: t.model, promptVersion: t.promptVersion,
      outcome: t.template ? 'template' : 'ai_text',
      detail: { attempts: t.attempts.length, rejected: t.attempts.filter((a) => a.problems.length).map((a) => a.problems), revision: event.revision },
    });
  }

  async ingest(items: SourceItem[], defaultArea?: { name: string; lat: number; lon: number; radiusM: number }): Promise<IngestReport> {
    const r: IngestReport = { received: items.length, new: 0, ignored: 0, eventsCreated: 0, eventsUpdated: 0, sentToReview: 0, alertsCreated: 0, pushes: 0, updates: 0, allClears: 0 };
    const touched = new Map<string, RiskEvent>();
    const outcome = new Map<string, Outcome>();
    const note = (id: string, o: Outcome) => { if (RANK[o] >= RANK[outcome.get(id) ?? 'touched']) outcome.set(id, o); };

    for (const item of items) {
      if (!await this.d.store.recordSourceItem(item)) continue; // seen before
      r.new++;
      let trace: ExtractTrace | null = null;
      const ext = await extract(item, { llm: this.d.llm, geocoder: this.d.geocoder, now: this.now(), defaultArea, onTrace: (t) => { trace = t; } });
      const sourceRef = `${item.source}:${item.externalId}`;
      const tr = trace as ExtractTrace | null;
      if (!ext || ext.lat == null || ext.lon == null) {
        r.ignored++;
        await this.log.record({
          kind: 'extract', sourceRef, model: tr?.model ?? null, promptVersion: tr?.promptVersion ?? null, outcome: 'dropped',
          detail: { method: tr?.method ?? null, reason: tr?.dropped ?? 'no location', title: item.title.slice(0, 200), source: item.sourceName, ...(tr?.modelOutput ? { modelOutput: tr.modelOutput } : {}) },
        });
        continue;
      }

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
      // Logged after the extraction itself, so the log reads in the order things happened.
      let gate: { outcome: string; detail: Record<string, unknown> } | null = null;
      if (existing) {
        event = touched.get(existing.id) ?? existing;
        const wasActive = !event.endsAt || Date.parse(event.endsAt) > this.now().getTime();
        const { escalated, changed } = mergeInto(event, ext, item, this.now());
        const endedNow = wasActive && !!event.endsAt && Date.parse(event.endsAt) <= this.now().getTime();
        note(event.id, endedNow ? 'all_clear' : escalated ? 'escalated' : changed ? 'changed' : 'touched');
        if (escalated && !event.official && event.severity >= this.d.config.reviewSeverity && event.status !== 'pending_review') {
          const from = event.status;
          event.status = 'pending_review';
          r.sentToReview++;
          gate = { outcome: 'pending_review', detail: { reason: `escalated to severity ${event.severity} (review from ${this.d.config.reviewSeverity})`, from } };
        }
        r.eventsUpdated++;
      } else {
        const needsReview = !item.official &&
          (ext.confidence < this.d.config.reviewConfidence || ext.severity >= this.d.config.reviewSeverity);
        event = newEvent(ext, item, needsReview ? 'pending_review' : 'auto', this.now());
        if (needsReview) r.sentToReview++;
        r.eventsCreated++;
        note(event.id, 'touched');
        const reasons = item.official ? ['official source'] : [
          ...(ext.confidence < this.d.config.reviewConfidence ? [`confidence ${ext.confidence} below ${this.d.config.reviewConfidence}`] : []),
          ...(ext.severity >= this.d.config.reviewSeverity ? [`severity ${ext.severity} (review from ${this.d.config.reviewSeverity})`] : []),
        ];
        gate = { outcome: event.status, detail: { reason: reasons.length ? reasons.join('; ') : 'confident, below review severity' } };
      }
      await this.log.record({
        kind: 'extract', eventId: event.id, sourceRef, model: tr?.model ?? null, promptVersion: tr?.promptVersion ?? null,
        outcome: existing ? 'merged' : 'new_event',
        detail: {
          method: tr?.method ?? null, category: ext.category, severity: ext.severity, confidence: ext.confidence, areaName: ext.areaName,
          title: item.title.slice(0, 200), source: item.sourceName, ...(tr?.modelOutput ? { modelOutput: tr.modelOutput } : {}),
        },
      });
      if (gate) await this.log.record({ kind: 'review_gate', eventId: event.id, sourceRef, ...gate });
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
    let t: ComposeTrace | null = null;
    const copy = await compose(event, this.d.llm, (x) => { t = x; });
    await this.logCompose(event, t);
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
      ...(isAhead(event, this.now()) ? { startsAt: event.onsetAt } : {}),
      createdAt: this.now().toISOString(),
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
    const res = { sent: await this.sendPush(outbox) };
    await this.log.record({ kind: 'rank', eventId: event.id, outcome: 'all_clear', detail: { alerts, pushes: res.sent, revision: event.revision } });
    return { alerts, pushes: res.sent };
  }

  /** Alert Desk: end an event now and send the all-clear. */
  async endEvent(eventId: string) {
    const e = await this.d.store.getEvent(eventId);
    if (!e) return null;
    await this.log.record({ kind: 'desk', actor: 'desk', eventId, outcome: 'ended', detail: { status: e.status, severity: e.severity } });
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

  /** "One pollen/UV push a day": was there one in the last 12 hours? */
  private async pollenUvPushedRecently(userId: string): Promise<boolean> {
    const since = this.now().getTime() - 12 * 3600_000;
    return (await this.d.store.alertsForUser(userId, 50)).some((a) => a.category === 'pollen_uv' && a.delivery === 'push' && Date.parse(a.createdAt) >= since);
  }

  /** Write copy if needed, then create alerts for every affected user. Only for released events. */
  async deliver(event: RiskEvent, onlyUsers?: User[], backfill = false): Promise<{ alerts: number; pushes: number }> {
    if (event.status !== 'auto' && event.status !== 'approved') return { alerts: 0, pushes: 0 };
    if (event.endsAt && Date.parse(event.endsAt) <= this.now().getTime()) return { alerts: 0, pushes: 0 };

    await this.ensureCopy(event);

    const outbox: Array<{ token: string; alert: Alert }> = [];
    let alerts = 0;
    const tally = new Map<string, number>();
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
        matchedPlace: m.place,
        ...(event.category === 'pollen_uv' ? { pollenUvPushedRecently: await this.pollenUvPushedRecently(user.id) } : {}),
      });
      // First sync after install: show what's going on without a burst of notifications.
      if (backfill && delivery === 'push' && !(event.official && event.severity === 5)) { delivery = 'feed'; reason = 'catch-up after setup'; }

      const alert = await this.alertFor(user, event, 'new', {
        title: m.place ? truncateTo(`${m.place}: ${event.copyTitle}`, 50, event.copyTitle!) : event.copyTitle!,
        body: event.copyBody!, action: event.copyAction!, delivery, reason, matchedPlace: m.place,
      });
      if (!alert) continue; // already alerted for this revision
      alerts++;
      tally.set(`${delivery}\u0000${reason}`, (tally.get(`${delivery}\u0000${reason}`) ?? 0) + 1);
      if (delivery === 'push' && user.pushToken) outbox.push({ token: user.pushToken, alert });
    }
    const res = { sent: await this.sendPush(outbox) };
    // Ranking per event as counts (never who): only when someone got something.
    if (alerts) {
      const byDelivery: Record<string, number> = {};
      const reasons = [...tally].map(([k, count]) => { const [delivery, reason] = k.split('\u0000'); byDelivery[delivery] = (byDelivery[delivery] ?? 0) + count; return { delivery, reason, count }; });
      await this.log.record({ kind: 'rank', eventId: event.id, outcome: 'delivered', detail: { alerts, pushes: res.sent, byDelivery, reasons, revision: event.revision, ...(onlyUsers ? { scope: backfill ? 'first sync' : 'one person moved or added a place' } : {}) } });
    }
    return { alerts, pushes: res.sent };
  }

  /**
   * Queue the pushes, then send right away. The queue (PRD 6.2 step 9) makes delivery survive a
   * crash between matching and sending, and lets several senders share a big fan-out.
   */
  private async sendPush(outbox: PushMessage[], attempt = 0): Promise<number> {
    if (!outbox.length) return 0;
    await this.d.store.enqueuePushJobs(outbox.map((m) => ({ token: m.token, alert: m.alert, attempt })), this.now().toISOString());
    return (await this.drainPushQueue()).sent;
  }

  /**
   * Sends everything in the delivery queue: `concurrency` senders, each claiming `batch` jobs at a
   * time (Expo takes 100 per request; ExpoPushSender splits). Keeps the tickets for the receipt
   * check and forgets tokens of uninstalled apps right away. Jobs whose send throws stay claimed
   * until their lock runs out, then the next drain retries them.
   */
  async drainPushQueue(): Promise<{ sent: number; errors: number; jobs: number }> {
    const { holder = 'pipeline', concurrency = 4, batch = 500 } = this.d.delivery ?? {};
    const out = { sent: 0, errors: 0, jobs: 0 };
    const sender = async () => {
      for (;;) {
        const now = this.now();
        const jobs = await this.d.store.claimPushJobs(holder, batch, now.toISOString(), new Date(now.getTime() + PUSH_JOB_LOCK_MS).toISOString());
        if (!jobs.length) return;
        for (const attempt of new Set(jobs.map((j) => j.attempt))) {
          const group = jobs.filter((j) => j.attempt === attempt);
          const res = await this.d.push.send(group.map((j) => ({ token: j.token, alert: j.alert })));
          await this.d.store.recordPushTickets(res.tickets, attempt, this.now().toISOString());
          await this.forgetUninstalled(res.tickets.filter((t) => t.error === 'DeviceNotRegistered'));
          out.sent += res.sent;
          out.errors += res.errors;
          M.pushes.inc({ result: 'sent' }, res.sent);
          M.pushes.inc({ result: 'error' }, res.errors);
          const sentAt = this.now().getTime();
          for (const j of group) M.pushLatency.observe({}, Math.max(0, (sentAt - Date.parse(j.alert.createdAt)) / 1000));
        }
        await this.d.store.completePushJobs(jobs.map((j) => j.id));
        out.jobs += jobs.length;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, sender));
    return out;
  }

  private async forgetUninstalled(tickets: Array<Pick<PushTicket, 'token'>>) {
    for (const token of new Set(tickets.map((t) => t.token))) await this.d.store.clearPushToken(token);
  }

  /**
   * Push receipts (PRD 5.4, 6.2 step 9). About 15 minutes after sending, ask Expo whether Apple/Google
   * took each push: delivered → done; DeviceNotRegistered → the app is gone, forget the token;
   * a transient error → send again (twice at most, the receipt check backs off between tries);
   * no receipt a day later → unknown. Run regularly; cheap when there's nothing to check.
   */
  /**
   * Evening summaries that are due now (PRD 6.1 #7): one push per person with the day's feed-only
   * alerts that are still running. Nothing to tell → no push. At most one per local day.
   * Scans every person each tick (cheap per row); a "due" index is for when there are many.
   */
  async sendDigests(): Promise<{ due: number; sent: number; pushes: number }> {
    const now = this.now();
    const out = { due: 0, sent: 0, pushes: 0 };
    const outbox: PushMessage[] = [];
    const running = new Map<string, boolean>();
    for (const user of await this.d.store.allUsers()) {
      if (!user.pushToken) continue;
      const day = digestDue(user.prefs, now);
      if (!day) continue;
      // Claimed first, even when there turns out to be nothing to say: each person is looked at once
      // a day, and tomorrow's summary picks up whatever comes in after this one.
      if (!(await this.d.store.claimDigest(user.id, day, now.toISOString()))) continue;
      out.due++;
      const alerts = await this.d.store.alertsForUser(user.id, 200);
      for (const a of alerts) {
        if (running.has(a.eventId)) continue;
        const e = await this.d.store.getEvent(a.eventId);
        running.set(a.eventId, !!e && e.status !== 'rejected' && (!e.endsAt || Date.parse(e.endsAt) > now.getTime()));
      }
      const items = digestItems(alerts, now, (id) => running.get(id) ?? false);
      if (!items.length) continue;
      out.sent++;
      outbox.push({ token: user.pushToken, alert: digestPush(items, contentLanguage(user.prefs.language)) });
    }
    out.pushes = await this.sendPush(outbox);
    return out;
  }

  async checkPushReceipts(opts: { waitMin?: number; maxResends?: number } = {}) {
    const out = { checked: 0, delivered: 0, failed: 0, resent: 0, tokensCleared: 0, unknown: 0 };
    const now = this.now().getTime();
    const tickets = await this.d.store.pushTicketsToCheck(new Date(now - (opts.waitMin ?? 15) * 60_000).toISOString(), 1000);
    if (!tickets.length) return out;
    const receipts = await this.d.push.getReceipts(tickets.map((t) => t.ticketId));
    const resend: Array<{ msg: PushMessage; attempt: number }> = [];
    for (const t of tickets) {
      const r = receipts.get(t.ticketId);
      if (!r) {
        if (now - Date.parse(t.createdAt) > 24 * 3600_000) { await this.d.store.setPushStatus(t.ticketId, 'unknown'); out.unknown++; }
        continue;
      }
      out.checked++;
      if (r.status === 'ok') { await this.d.store.setPushStatus(t.ticketId, 'delivered'); out.delivered++; continue; }
      if (r.error === 'DeviceNotRegistered') {
        out.tokensCleared += await this.d.store.clearPushToken(t.token);
      } else if (TRANSIENT_PUSH_ERRORS.has(r.error) && t.attempt < (opts.maxResends ?? 2)) {
        const user = await this.d.store.getUser(t.userId);
        const alert = user?.pushToken ? await this.d.store.getAlert(t.userId, t.alertId) : null;
        if (user?.pushToken && alert) {
          await this.d.store.setPushStatus(t.ticketId, 'retried', r.error);
          resend.push({ msg: { token: user.pushToken, alert }, attempt: t.attempt + 1 });
          continue;
        }
      }
      await this.d.store.setPushStatus(t.ticketId, 'error', r.error);
      out.failed++;
    }
    for (const attempt of new Set(resend.map((r) => r.attempt))) {
      out.resent += await this.sendPush(resend.filter((r) => r.attempt === attempt).map((r) => r.msg), attempt);
    }
    return out;
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
    await this.log.record({
      kind: 'desk', actor: 'desk', eventId, outcome: 'approved',
      detail: { from: e.status, severity: edits?.severity ?? e.severity, ...(edits?.severity && edits.severity !== e.severity ? { severityWas: e.severity } : {}), editedTitle: !!edits?.title, editedBody: !!edits?.body },
    });
    e.status = 'approved';
    if (edits?.severity && edits.severity !== e.severity) {
      e.severity = edits.severity;
      e.copyTitle = e.copyBody = e.copyAction = null;
    }
    if ((edits?.title || edits?.body) && !e.copyTitle) {
      // Write the AI copy first, so the reviewer's edits override it rather than being overwritten.
      let t: ComposeTrace | null = null;
      const copy = await compose(e, this.d.llm, (x) => { t = x; });
      await this.logCompose(e, t);
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
    await this.log.record({ kind: 'desk', actor: 'desk', eventId, outcome: 'rejected', detail: { from: e.status, severity: e.severity, category: e.category } });
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
    event.copyAction = recommendedAction(event.category, event.severity, event.language, undefined, packFor(event));
    await this.d.store.saveEvent(event);
    await this.log.record({ kind: 'desk', actor: 'desk', eventId: event.id, sourceRef: item.externalId, outcome: 'manual_alert', detail: { category: event.category, severity: event.severity, title: event.copyTitle, areaName: event.areaName } });
    const out = await this.deliver(event);
    return { eventId: event.id, ...out };
  }
}

function truncateTo(s: string, max: number, fallback: string) {
  return s.length <= max ? s : fallback;
}
