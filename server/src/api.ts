import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { hashToken } from './db.js';
import { POLLEN_UV_KEYS } from './sources/dwd-health.js';
import cors from '@fastify/cors';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Pipeline } from './pipeline/run.js';
import { CATEGORIES, DECISION_KINDS, DEFAULT_PREFS, UI_LANGUAGES, contentLanguage, stampConsent, type Reviewer, type User } from './types.js';
import { DESK_HTML } from './desk.js';
import { deskCases } from './eval/desk-export.js';
import { decisionsCsv } from './decisions.js';
import { computeKpis } from './kpis.js';
import { AppEventsBody, countEvents, funnelReport } from './app-events.js';
import { crimeBiasReport, quarterOf, quarterRange } from './bias-report.js';
import { LoginLimiter, MIN_PASSWORD_LENGTH, SESSION_HOURS, clearedCookie, dummyHash, hashPassword, newSessionToken, readCookie, reviewTimes, sessionCookie, tokenEquals, verifyPassword } from './desk-auth.js';
import { sourceReport } from './sources/registry.js';
import { MAX_PLACE_RADIUS_M, distanceM } from './geo.js';
import { AuthError, checkEmailCode, signIn, signInWithIdentity, signOut, startEmailSignIn, type Mailer } from './auth.js';
import { IdentityError, nonceMatches, type IdentityVerifier } from './identity.js';
import type { IdentityProvider } from './store.js';
import { logError, defaultSink, type ErrorSink } from './errors.js';
import { HISTORY_SCAN, searchHistory } from './history.js';
import { M } from './metrics.js';
import { followableServices, US_STATUS_PAGES, type StatusPage } from './sources/statuspage.js';

const PrefsSchema = z.object({
  categories: z.array(z.enum(CATEGORIES)),
  quietHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).nullable(),
  dailyLimit: z.number().int().min(1).max(20),
  timezone: z.string(),
  language: z.enum(UI_LANGUAGES),
  insightsConsent: z.boolean(),
  digestTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  // Status-page keys; unknown keys are kept (a service may come back to the list later).
  techServices: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)).max(100).nullable(),
  pollenUv: z.array(z.enum(POLLEN_UV_KEYS)).max(POLLEN_UV_KEYS.length).nullable(),
}).partial();

const Coord = { lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) };

export interface ApiDeps {
  store: Store;
  pipeline: Pipeline;
  adminToken: string;
  /** Sends sign-in codes; null = email sign-in not configured. */
  mailer?: Mailer | null;
  /** Sign in with Apple / Google; a missing provider answers 503 (client ids not set). */
  identity?: Partial<Record<IdentityProvider, IdentityVerifier>>;
  /** Per-source ingest health for /health (no error texts). */
  ingestStatus?: () => Record<string, { ok: boolean; running: boolean; lastOkAt: string | null }>;
  runIngest: () => Promise<unknown>;
  /** Role and worker-lease state for /health (multi-machine setups). */
  /** For source health on the Alert Desk (stale after 3 intervals). */
  pollIntervalSec?: number;
  /** Daily AI budget, shown next to the spend on the Alert Desk. */
  aiBudgetEur?: number;
  roleStatus?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Services people can follow for technology outages (GET /v1/services). Default: the US status pages. */
  statusPages?: StatusPage[];
  /** Clock for time-dependent answers (tests pin it; default: real time). */
  now?: () => Date;
  /** Where unexpected errors are logged (default: JSON lines on stderr). */
  errorSink?: ErrorSink;
}

const REGION_MAX_RADIUS_M = 30_000;
const REGION_NEAR_M = 50_000;
/** iOS watches at most 20 regions: one home area, up to 15 events, the rest for saved places. */
const REGION_MAX = 15;

export function buildApi({ store, pipeline, adminToken, runIngest, ingestStatus, roleStatus, pollIntervalSec = 120, aiBudgetEur = 0, mailer = null, identity = {}, statusPages = US_STATUS_PAGES, errorSink = defaultSink, now: clock = () => new Date() }: ApiDeps) {
  const app = Fastify({ logger: false });
  // Request metrics by route pattern (never the URL itself: no ids or tokens in labels).
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    M.http.inc({ route, method: req.method, status: `${Math.floor(reply.statusCode / 100)}xx` });
    M.httpSeconds.observe({ route }, reply.elapsedTime / 1000);
  });
  // Any origin may call the API: it uses bearer tokens, never cookies. The web app needs PUT and DELETE too.
  app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'] });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', details: err.issues });
    // Fastify's own client errors (malformed JSON, wrong content type, body too large) keep their 4xx.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
    // Route pattern only (e.g. /v1/alerts/:id): no ids, query strings or tokens in the log.
    logError('http', err, { method: req.method, route: req.routeOptions.url ?? 'unknown' }, errorSink);
    return reply.code(500).send({ error: 'internal' });
  });

  const bearer = (req: FastifyRequest) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const authed = async (req: FastifyRequest, reply: FastifyReply): Promise<User | null> => {
    const token = bearer(req);
    const user = token ? await store.userByToken(token) : null;
    if (!user) reply.code(401).send({ error: 'unauthorized' });
    return user;
  };
  /**
   * Alert Desk access (PRD 6.2 step 5): the admin token, or a reviewer's session cookie plus the
   * `x-desk` header. Returns who acts, for the decision log: 'desk' for the token, the reviewer's
   * email otherwise.
   */
  const deskActor = async (req: FastifyRequest): Promise<{ actor: string; reviewer: Reviewer | null } | null> => {
    const t = (req.headers['x-admin-token'] as string) ?? (req.query as any)?.token;
    if (t != null) return tokenEquals(t, adminToken) ? { actor: 'desk', reviewer: null } : null;
    const cookie = readCookie(req.headers.cookie);
    if (!cookie || req.headers['x-desk'] !== '1') return null;
    const reviewer = await store.reviewerBySession(hashToken(cookie), clock().toISOString());
    return reviewer ? { actor: reviewer.email, reviewer } : null;
  };
  const admin = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const who = await deskActor(req);
    if (!who) { reply.code(401).send({ error: 'unauthorized' }); return null; }
    return who.actor;
  };
  /** Only the admin token (managing reviewers). */
  const adminTokenOnly = (req: FastifyRequest, reply: FastifyReply) => {
    if (tokenEquals(req.headers['x-admin-token'] as string | undefined, adminToken)) return true;
    reply.code(403).send({ error: 'admin_token_required' });
    return false;
  };
  const loginLimiter = new LoginLimiter();
  /** Anonymous app events: at most 60 requests per address per 10 minutes. */
  const eventLimiter = new LoginLimiter(60, 10 * 60_000);

  // Always 200 while the process is up (Fly's health check). `sources` shows which feeds last worked when.
  app.get('/health', async () => {
    const role = (await roleStatus?.()) ?? {};
    if (!ingestStatus) return { ok: true, ...role };
    const sources = Object.fromEntries(Object.entries(ingestStatus()).map(([k, v]) => [k, { ok: v.ok, running: v.running, lastOkAt: v.lastOkAt }]));
    return { ok: true, ...role, sources };
  });

  // Public: the list behind "only the services I use" (no user data).
  app.get('/v1/services', async () => ({ services: followableServices(statusPages) }));

  /**
   * Anonymous app events (PRD 13): onboarding steps, permission answers, notifications switched off.
   * Public, because onboarding happens before the device registers. Nothing that identifies the
   * person is read or kept: only +1 per day, platform and event name.
   */
  app.post('/v1/events', async (req, reply) => {
    const now = clock();
    const key = [`events:${req.ip}`];
    if (eventLimiter.blocked(key, now.getTime())) return reply.code(429).send({ error: 'too_many_requests' });
    eventLimiter.fail(key, now.getTime());
    const body = AppEventsBody.parse(req.body);
    await store.addAppEvents(now.toISOString().slice(0, 10), body.platform, countEvents(body.events));
    return { ok: true };
  });

  // ── device / user ────────────────────────────────────────────────────────
  app.post('/v1/devices', async (req) => {
    const body = z.object({ pushToken: z.string().nullable().optional(), prefs: PrefsSchema.optional() }).parse(req.body ?? {});
    const { user, token } = await store.createUser(body.pushToken ?? null, stampConsent(null, { ...DEFAULT_PREFS, ...body.prefs }));
    return { userId: user.id, token, prefs: user.prefs };
  });

  app.get('/v1/me', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const account = await store.accountForUser(u.id);
    return { userId: u.id, prefs: u.prefs, places: await store.places(u.id), hasLocation: u.lat != null, account: account ? { email: account.email } : null };
  });

  app.put('/v1/me/prefs', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const prefs = stampConsent(u.prefs, { ...DEFAULT_PREFS, ...u.prefs, ...PrefsSchema.parse(req.body) });
    await store.updatePrefs(u.id, prefs);
    return { prefs };
  });

  app.put('/v1/me/push-token', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    await store.updatePushToken(u.id, z.object({ pushToken: z.string().nullable() }).parse(req.body).pushToken);
    return { ok: true };
  });

  /** Latest location only. Overwrites the previous point — no history is kept. */
  app.post('/v1/me/location', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const { lat, lon, firstSync } = z.object({ ...Coord, firstSync: z.boolean().optional() }).parse(req.body);
    await store.updateLocation(u.id, lat, lon);
    const alerts = await pipeline.refreshUser((await store.getUser(u.id))!, firstSync ?? false);
    return { ok: true, newAlerts: alerts };
  });

  app.get('/v1/me/places', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    return { places: await store.places(u.id) };
  });

  app.post('/v1/me/places', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const b = z.object({ label: z.string().min(1).max(40), ...Coord, radiusM: z.number().min(100).max(MAX_PLACE_RADIUS_M).default(500) }).parse(req.body);
    if ((await store.places(u.id)).length >= 10) return reply.code(400).send({ error: 'too_many_places' });
    const place = await store.addPlace(u.id, b.label, b.lat, b.lon, b.radiusM);
    await pipeline.refreshUser(u, true);
    return { place };
  });

  app.delete('/v1/me/places/:id', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    await store.deletePlace(u.id, (req.params as any).id);
    return { ok: true };
  });

  /** GDPR Art. 17 — delete account and all data. */
  app.delete('/v1/me', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    await store.deleteUser(u.id);
    return { ok: true };
  });

  // ── sign-in (email code) ───────────────────────────────────────────────
  const Email = z.string().trim().email().max(254);
  const authError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.code });
    throw err;
  };

  /** Sends a 6-digit code. Same answer whether or not the address has an account. */
  app.post('/v1/auth/email/start', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const { email } = z.object({ email: Email }).parse(req.body);
    try { await startEmailSignIn(store, mailer, email, contentLanguage(u.prefs.language)); } catch (err) { return authError(reply, err); }
    return reply.code(202).send({ ok: true });
  });

  /** Checks the code and attaches this device to the account (creating it, or restoring its data). */
  app.post('/v1/auth/email/verify', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const { email, code } = z.object({ email: Email, code: z.string().trim().regex(/^\d{6}$/) }).parse(req.body);
    if (!(await checkEmailCode(store, email, code))) return reply.code(400).send({ error: 'invalid_code' });
    const { user, account } = await signIn(store, bearer(req), u, email);
    return { userId: user.id, prefs: user.prefs, places: await store.places(user.id), account: { email: account.email } };
  });

  /**
   * Sign in with Apple / Google: the app sends the identity token from the provider's sheet;
   * the server checks it (identity.ts) and attaches this device like the email code does.
   */
  /** Which sign-in methods this server has switched on, so apps only show buttons that work. */
  app.get('/v1/auth/providers', async () => ({ email: mailer != null, apple: identity.apple != null, google: identity.google != null }));

  for (const provider of ['apple', 'google'] as const) {
    app.post(`/v1/auth/${provider}`, async (req, reply) => {
      const u = await authed(req, reply); if (!u) return;
      const { idToken, nonce } = z.object({ idToken: z.string().min(20).max(8192), nonce: z.string().min(16).max(128) }).parse(req.body);
      const verifier = identity[provider];
      if (!verifier) return reply.code(503).send({ error: 'provider_not_configured' });
      let claims;
      try { claims = await verifier.verify(idToken); } catch (err) {
        if (err instanceof IdentityError) {
          if (err.code === 'provider_unavailable') logError(`auth:${provider}`, err, {}, errorSink);
          return reply.code(err.code === 'invalid_token' ? 400 : 503).send({ error: err.code });
        }
        throw err;
      }
      if (!nonceMatches(claims, nonce)) return reply.code(400).send({ error: 'invalid_token' });
      try {
        const { user, account } = await signInWithIdentity(store, bearer(req), u, provider, claims);
        return { userId: user.id, prefs: user.prefs, places: await store.places(user.id), account: { email: account.email } };
      } catch (err) { return authError(reply, err); }
    });
  }

  /** This device gets a fresh anonymous identity; the account keeps its data. Returns the new token. */
  app.post('/v1/auth/signout', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    try {
      const { user, token } = await signOut(store, bearer(req), u);
      return { userId: user.id, token, prefs: user.prefs };
    } catch (err) { return authError(reply, err); }
  });

  /**
   * OS geofencing hint (PRD 5.3, 11): circles of active, approved events near the person's last
   * location, so the phone can wake up when it enters one and send its location at once.
   * Only local events (radius ≤ 30 km, within 50 km) in topics the person follows, closest first.
   * No exact outlines and nothing about other people.
   */
  app.get('/v1/me/regions', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    if (u.lat == null || u.lon == null) return { regions: [] };
    const now = clock();
    const regions = (await store.activeEvents(now))
      .filter((e) => e.status !== 'pending_review' && e.status !== 'rejected')
      .filter((e) => !e.endsAt || Date.parse(e.endsAt) > now.getTime())
      .filter((e) => u.prefs.categories.includes(e.category) && e.radiusM <= REGION_MAX_RADIUS_M)
      .map((e) => ({ id: e.id, lat: e.lat, lon: e.lon, radiusM: Math.max(200, Math.round(e.radiusM)), d: distanceM(u.lat!, u.lon!, e.lat, e.lon) }))
      .filter((r) => r.d - r.radiusM <= REGION_NEAR_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, REGION_MAX)
      .map(({ d: _d, ...r }) => r);
    return { regions };
  });

  // ── alerts ───────────────────────────────────────────────────────────────
  app.get('/v1/me/alerts', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    // The feed is loaded in the foreground only (background tasks send locations): the person used the app.
    await store.markSeen(u.id, clock().toISOString()).catch((e) => logError('kpis', e));
    const limit = Math.min(Number((req.query as any)?.limit ?? 50), 200);
    // `ended`: the event is over (ran out or was lifted) — the app greys these out.
    const now = clock().getTime();
    const endedById = new Map<string, boolean>();
    const alerts = [];
    for (const a of await store.alertsForUser(u.id, limit)) {
      if (!endedById.has(a.eventId)) {
        const e = await store.getEvent(a.eventId);
        endedById.set(a.eventId, !e || e.status === 'rejected' || (!!e.endsAt && Date.parse(e.endsAt) <= now));
      }
      alerts.push({ ...a, kind: a.kind ?? 'new', ended: endedById.get(a.eventId)! });
    }
    return { alerts };
  });

  // Search the person's own past alerts: one entry per incident, newest first.
  const HistoryQuerySchema = z.object({
    q: z.string().max(100).optional(),
    category: z.enum(CATEGORIES).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  app.get('/v1/me/history', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    await store.markSeen(u.id, clock().toISOString()).catch((e) => logError('kpis', e));
    const query = HistoryQuerySchema.parse(req.query ?? {});
    const now = clock().getTime();
    const found = searchHistory(await store.alertsForUser(u.id, HISTORY_SCAN), query);
    const alerts = [];
    for (const a of found) {
      const e = await store.getEvent(a.eventId);
      alerts.push({ ...a, kind: a.kind ?? 'new', ended: !e || e.status === 'rejected' || (!!e.endsAt && Date.parse(e.endsAt) <= now) || a.kind === 'all_clear' });
    }
    return { alerts };
  });

  app.get('/v1/alerts/:id', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const alert = await store.getAlert(u.id, (req.params as any).id);
    if (!alert) return reply.code(404).send({ error: 'not_found' });
    // Product KPIs (PRD 13): opened, and the person used the app. Never block the answer on it.
    const nowIso = clock().toISOString();
    await Promise.all([store.markAlertOpened(u.id, alert.id, nowIso), store.markSeen(u.id, nowIso)]).catch((e) => logError('kpis', e));
    const event = await store.getEvent(alert.eventId);
    return { alert, sources: event?.sources ?? [], summary: event?.summary ?? '', endsAt: event?.endsAt ?? null };
  });

  app.post('/v1/alerts/:id/feedback', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const { value } = z.object({ value: z.enum(['relevant', 'not_relevant']) }).parse(req.body);
    if (!(await store.setFeedback(u.id, (req.params as any).id, value))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ── Alert Desk / admin ───────────────────────────────────────────────────
  app.get('/admin', async (_req, reply) => reply.type('text/html').send(DESK_HTML));

  app.get('/admin/api/pending', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    return { events: await store.eventsByStatus('pending_review') };
  });

  app.get('/admin/api/active', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    return { events: await store.activeEvents(clock()) };
  });

  app.post('/admin/api/events/:id/approve', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const edits = z.object({ title: z.string().max(50).optional(), body: z.string().max(100).optional(), severity: z.number().int().min(1).max(5).optional() })
      .parse(req.body ?? {});
    const res = await pipeline.approve((req.params as any).id, edits as any, actor);
    if (!res) return reply.code(404).send({ error: 'not_found' });
    return res;
  });

  app.post('/admin/api/events/:id/reject', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    return { ok: await pipeline.reject((req.params as any).id, actor) };
  });

  // ── Alert Desk accounts ──────────────────────────────────────────────────
  app.post('/admin/api/login', async (req, reply) => {
    const b = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(req.body);
    const email = b.email.trim().toLowerCase();
    const keys = [`email:${email}`, `ip:${req.ip}`];
    const now = clock().getTime();
    if (loginLimiter.blocked(keys, now)) return reply.code(429).send({ error: 'too_many_attempts' });
    const r = await store.reviewerByEmail(email);
    const ok = await verifyPassword(b.password, r?.passwordHash ?? await dummyHash());
    if (!r || !ok || r.disabled) {
      loginLimiter.fail(keys, now);
      return reply.code(401).send({ error: 'wrong_email_or_password' });
    }
    loginLimiter.clear(keys);
    const { token, tokenHash } = newSessionToken();
    await store.createReviewerSession(tokenHash, r.id, new Date(now + SESSION_HOURS * 3600_000).toISOString());
    reply.header('set-cookie', sessionCookie(token));
    return { reviewer: { email: r.email, name: r.name } };
  });

  app.post('/admin/api/logout', async (req, reply) => {
    const cookie = readCookie(req.headers.cookie);
    if (cookie) await store.deleteReviewerSession(hashToken(cookie));
    reply.header('set-cookie', clearedCookie());
    return { ok: true };
  });

  /** Who is signed in (the desk shows the name and decides between login form and desk). */
  app.get('/admin/api/me', async (req, reply) => {
    const who = await deskActor(req);
    if (!who) return reply.code(401).send({ error: 'unauthorized' });
    return { actor: who.actor, reviewer: who.reviewer ? { email: who.reviewer.email, name: who.reviewer.name } : null, admin: !who.reviewer };
  });

  const publicReviewer = (r: Reviewer) => ({ id: r.id, email: r.email, name: r.name, createdAt: r.createdAt, disabled: r.disabled });
  app.get('/admin/api/reviewers', async (req, reply) => {
    if (!adminTokenOnly(req, reply)) return;
    return { reviewers: (await store.reviewers()).map(publicReviewer) };
  });

  app.post('/admin/api/reviewers', async (req, reply) => {
    if (!adminTokenOnly(req, reply)) return;
    const b = z.object({ email: z.string().email().max(200), name: z.string().trim().min(1).max(100), password: z.string().min(MIN_PASSWORD_LENGTH).max(200) }).parse(req.body);
    const email = b.email.trim().toLowerCase();
    if (await store.reviewerByEmail(email)) return reply.code(409).send({ error: 'exists' });
    const r: Reviewer = { id: randomUUID(), email, name: b.name, passwordHash: await hashPassword(b.password), createdAt: clock().toISOString(), disabled: false };
    await store.createReviewer(r);
    return publicReviewer(r);
  });

  /** Rename, new password, or switch off (signs them out everywhere). */
  app.put('/admin/api/reviewers/:id', async (req, reply) => {
    if (!adminTokenOnly(req, reply)) return;
    const b = z.object({ name: z.string().trim().min(1).max(100).optional(), password: z.string().min(MIN_PASSWORD_LENGTH).max(200).optional(), disabled: z.boolean().optional() }).parse(req.body);
    const id = (req.params as any).id as string;
    const ok = await store.updateReviewer(id, { name: b.name, disabled: b.disabled, ...(b.password ? { passwordHash: await hashPassword(b.password) } : {}) });
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    if (b.disabled || b.password) await store.deleteReviewerSessionsFor(id);
    return { ok: true };
  });

  /** Product KPIs with the PRD's red lines (section 13), over the last `days` (default 7). */
  app.get('/admin/api/kpis', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query ?? {});
    const now = clock();
    const sinceIso = new Date(now.getTime() - days * 86_400_000).toISOString();
    // Retractions can come after the alert; look back further than the period.
    const retracted = (await store.decisions({ kind: 'desk', since: new Date(now.getTime() - (days + 30) * 86_400_000).toISOString(), limit: 10_000 }))
      .filter((d) => d.outcome === 'ended' && d.detail.reason === 'false_alert' && d.eventId).map((d) => d.eventId!);
    return { days, kpis: computeKpis(await store.kpiInputs(sinceIso), { sinceIso, now, falseAlertEvents: new Set(retracted) }) };
  });

  /** Onboarding funnel and permission answers from the anonymous app events, last `days` (default 7). */
  app.get('/admin/api/funnel', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query ?? {});
    const since = new Date(clock().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return { days, since, ...funnelReport(await store.appEventCounts(since)) };
  });

  /**
   * Quarterly crime bias review (PRD 6.3): crime alerts per Berlin district against its population.
   * Desk only; no area score ever reaches the apps. `quarter` like 2026-Q4, default the current one.
   */
  app.get('/admin/api/crime-bias', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const { quarter } = z.object({ quarter: z.string().regex(/^\d{4}-Q[1-4]$/).optional() }).parse(req.query ?? {});
    const q = quarter ?? quarterOf(clock());
    const { from, to } = quarterRange(q);
    return crimeBiasReport(await store.eventsStartedBetween('crime', from, to), q);
  });

  /** Review time (target < 3 min) over the last `days` (default 7). */
  app.get('/admin/api/review-time', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query ?? {});
    const since = new Date(clock().getTime() - days * 86_400_000).toISOString();
    const rows = (await store.decisions({ kind: 'desk', since, limit: 10_000 })).filter((d) => typeof d.detail.reviewSeconds === 'number');
    const byReviewer: Record<string, number[]> = {};
    for (const d of rows) (byReviewer[d.actor] ??= []).push(d.detail.reviewSeconds as number);
    return {
      days,
      ...reviewTimes(rows.map((d) => d.detail.reviewSeconds as number)),
      byReviewer: Object.entries(byReviewer).map(([reviewer, s]) => ({ reviewer, ...reviewTimes(s) })),
    };
  });

  /** Decision log (PRD 6.3): every pipeline step and Alert Desk action. JSON or CSV. */
  const DecisionQ = z.object({
    eventId: z.string().max(100).optional(),
    kind: z.enum(DECISION_KINDS).optional(),
    since: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date').optional(),
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
  });
  app.get('/admin/api/decisions', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    return { decisions: await store.decisions(DecisionQ.parse(req.query ?? {})) };
  });
  app.get('/admin/api/decisions.csv', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const q = DecisionQ.parse(req.query ?? {});
    const rows = await store.decisions({ ...q, limit: q.limit ?? 10_000 });
    reply.header('content-disposition', `attachment; filename="decisions-${clock().toISOString().slice(0, 10)}.csv"`);
    return reply.type('text/csv; charset=utf-8').send(decisionsCsv(rows));
  });

  /** Reviewed events as labelled cases for the AI eval set (server/eval/cases/, PRD 6.4). */
  app.get('/admin/api/eval-export', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const { since } = z.object({ since: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date').optional() }).parse(req.query ?? {});
    const events = [...(await store.eventsByStatus('approved')), ...(await store.eventsByStatus('rejected'))];
    const file = deskCases(events, { since, now: clock() });
    reply.header('content-disposition', `attachment; filename="desk-${clock().toISOString().slice(0, 10)}.json"`);
    return file;
  });

  /** Concierge pilot: send a hand-curated alert. */
  app.post('/admin/api/manual-alert', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const b = z.object({
      category: z.enum(CATEGORIES), severity: z.number().int().min(1).max(5),
      title: z.string().min(3).max(50), body: z.string().min(3).max(100),
      sourceName: z.string().min(2), sourceUrl: z.string().url().optional(),
      ...Coord, radiusM: z.number().min(100).max(50000), areaName: z.string().min(2), endsAt: z.string().optional(),
      language: z.enum(['de', 'en']).optional(),
    }).parse(req.body);
    return pipeline.manualAlert(b as any, actor);
  });

  /** End an active event now and send the all-clear to everyone who got it. */
  app.post('/admin/api/events/:id/end', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const { reason } = z.object({ reason: z.enum(['over', 'false_alert']).default('over') }).parse(req.body ?? {});
    const out = await pipeline.endEvent((req.params as any).id, actor, reason);
    if (!out) return reply.code(404).send({ error: 'not_found' });
    return out;
  });

  app.post('/admin/api/ingest', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    return runIngest();
  });

  app.get('/admin/api/sources', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    return { sources: sourceReport(await store.sourceStatuses(), pollIntervalSec) };
  });

  app.get('/admin/api/ai-usage', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const from = new Date(clock().getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    const days = await store.llmUsage(from);
    const today = clock().toISOString().slice(0, 10);
    const total = days.reduce((s, d) => s + d.eur, 0);
    const users = (await store.allUsers()).length;
    return {
      budgetEur: aiBudgetEur,
      today: days.find((d) => d.day === today) ?? { day: today, calls: 0, inputTokens: 0, outputTokens: 0, eur: 0, skipped: 0 },
      last30Eur: Math.round(total * 100) / 100,
      perUser30dEur: users ? Math.round((total / users) * 10_000) / 10_000 : null,
      days,
    };
  });

  app.get('/admin/api/metrics', async (req, reply) => {
    const actor = await admin(req, reply); if (!actor) return;
    const days = Number((req.query as any)?.days ?? 7);
    return await store.metrics(new Date(clock().getTime() - days * 86_400_000).toISOString());
  });

  return app;
}
