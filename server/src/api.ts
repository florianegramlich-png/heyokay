import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Pipeline } from './pipeline/run.js';
import { CATEGORIES, DEFAULT_PREFS, type User } from './types.js';
import { DESK_HTML } from './desk.js';
import { MAX_PLACE_RADIUS_M } from './geo.js';
import { logError, stderrSink, type ErrorSink } from './errors.js';

const PrefsSchema = z.object({
  categories: z.array(z.enum(CATEGORIES)),
  quietHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).nullable(),
  dailyLimit: z.number().int().min(1).max(20),
  timezone: z.string(),
  language: z.enum(['de', 'en']),
}).partial();

const Coord = { lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) };

export interface ApiDeps {
  store: Store;
  pipeline: Pipeline;
  adminToken: string;
  runIngest: () => Promise<unknown>;
  /** Where unexpected errors are logged (default: JSON lines on stderr). */
  errorSink?: ErrorSink;
}

export function buildApi({ store, pipeline, adminToken, runIngest, errorSink = stderrSink }: ApiDeps) {
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', details: err.issues });
    // Fastify's own client errors (malformed JSON, wrong content type, body too large) keep their 4xx.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
    // Route pattern only (e.g. /v1/alerts/:id): no ids, query strings or tokens in the log.
    logError('http', err, { method: req.method, route: req.routeOptions.url ?? 'unknown' }, errorSink);
    return reply.code(500).send({ error: 'internal' });
  });

  const authed = async (req: FastifyRequest, reply: FastifyReply): Promise<User | null> => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const user = token ? await store.userByToken(token) : null;
    if (!user) reply.code(401).send({ error: 'unauthorized' });
    return user;
  };
  const admin = (req: FastifyRequest, reply: FastifyReply) => {
    const t = (req.headers['x-admin-token'] as string) ?? (req.query as any)?.token;
    if (t !== adminToken) { reply.code(401).send({ error: 'unauthorized' }); return false; }
    return true;
  };

  app.get('/health', async () => ({ ok: true }));

  // ── device / user ────────────────────────────────────────────────────────
  app.post('/v1/devices', async (req) => {
    const body = z.object({ pushToken: z.string().nullable().optional(), prefs: PrefsSchema.optional() }).parse(req.body ?? {});
    const { user, token } = await store.createUser(body.pushToken ?? null, body.prefs);
    return { userId: user.id, token, prefs: user.prefs };
  });

  app.get('/v1/me', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    return { userId: u.id, prefs: u.prefs, places: await store.places(u.id), hasLocation: u.lat != null };
  });

  app.put('/v1/me/prefs', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const prefs = { ...DEFAULT_PREFS, ...u.prefs, ...PrefsSchema.parse(req.body) };
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

  // ── alerts ───────────────────────────────────────────────────────────────
  app.get('/v1/me/alerts', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const limit = Math.min(Number((req.query as any)?.limit ?? 50), 200);
    // `ended`: the event is over (ran out or was lifted) — the app greys these out.
    const now = Date.now();
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

  app.get('/v1/alerts/:id', async (req, reply) => {
    const u = await authed(req, reply); if (!u) return;
    const alert = await store.getAlert(u.id, (req.params as any).id);
    if (!alert) return reply.code(404).send({ error: 'not_found' });
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
    if (!admin(req, reply)) return;
    return { events: await store.eventsByStatus('pending_review') };
  });

  app.get('/admin/api/active', async (req, reply) => {
    if (!admin(req, reply)) return;
    return { events: await store.activeEvents(new Date()) };
  });

  app.post('/admin/api/events/:id/approve', async (req, reply) => {
    if (!admin(req, reply)) return;
    const edits = z.object({ title: z.string().max(50).optional(), body: z.string().max(100).optional(), severity: z.number().int().min(1).max(5).optional() })
      .parse(req.body ?? {});
    const res = await pipeline.approve((req.params as any).id, edits as any);
    if (!res) return reply.code(404).send({ error: 'not_found' });
    return res;
  });

  app.post('/admin/api/events/:id/reject', async (req, reply) => {
    if (!admin(req, reply)) return;
    return { ok: await pipeline.reject((req.params as any).id) };
  });

  /** Concierge pilot: send a hand-curated alert. */
  app.post('/admin/api/manual-alert', async (req, reply) => {
    if (!admin(req, reply)) return;
    const b = z.object({
      category: z.enum(CATEGORIES), severity: z.number().int().min(1).max(5),
      title: z.string().min(3).max(50), body: z.string().min(3).max(100),
      sourceName: z.string().min(2), sourceUrl: z.string().url().optional(),
      ...Coord, radiusM: z.number().min(100).max(50000), areaName: z.string().min(2), endsAt: z.string().optional(),
      language: z.enum(['de', 'en']).optional(),
    }).parse(req.body);
    return pipeline.manualAlert(b as any);
  });

  /** End an active event now and send the all-clear to everyone who got it. */
  app.post('/admin/api/events/:id/end', async (req, reply) => {
    if (!admin(req, reply)) return;
    const out = await pipeline.endEvent((req.params as any).id);
    if (!out) return reply.code(404).send({ error: 'not_found' });
    return out;
  });

  app.post('/admin/api/ingest', async (req, reply) => {
    if (!admin(req, reply)) return;
    return runIngest();
  });

  app.get('/admin/api/metrics', async (req, reply) => {
    if (!admin(req, reply)) return;
    const days = Number((req.query as any)?.days ?? 7);
    return await store.metrics(new Date(Date.now() - days * 86_400_000).toISOString());
  });

  return app;
}
