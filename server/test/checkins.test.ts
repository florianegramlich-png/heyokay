import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender, toExpoMessage } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { MemoryMailer } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { CHECKIN_REMIND_MIN, answerPush, checkinEligible } from '../src/checkins.js';
import { describeSource } from '../src/sources/registry.js';
import type { RiskEvent } from '../src/types.js';

// PRD 6.1 #8: "Hey, okay?" check-ins. A severe event in a family member's own zone asks them;
// one tap tells the family; one gentle reminder; never emergency services; the family only ever
// sees the answer, never the event or the place.

const OSTKREUZ = { lat: 52.503, lon: 13.469 };
const MUENCHEN = { lat: 48.137, lon: 11.575 };

function event(over: Partial<RiskEvent> = {}, at = new Date()): RiskEvent {
  const now = at.toISOString();
  const id = randomUUID();
  return {
    id, revision: 1, status: 'auto', category: 'public_safety', severity: 4, confidence: 0.9, official: true,
    title: 'Großbrand', summary: 'Großbrand in Friedrichshain', facts: '', areaName: 'Friedrichshain',
    ...OSTKREUZ, radiusM: 1500, startsAt: now, endsAt: null,
    sources: [{ sourceName: 'Feuerwehr Berlin', externalId: id, title: 'Großbrand', official: true }],
    copyTitle: null, copyBody: null, copyAction: null, copyIsTemplate: false, createdAt: now, updatedAt: now,
    ...over,
  };
}

describe('who is asked', () => {
  const base = { kind: 'new', delivery: 'push', self: true, backfill: false, ahead: false };
  it('severe events in the person\'s own zone, on topics where "are you okay?" makes sense', () => {
    expect(checkinEligible({ severity: 4, category: 'public_safety' }, base)).toBe(true);
    expect(checkinEligible({ severity: 5, category: 'weather' }, base)).toBe(true);
    expect(checkinEligible({ severity: 3, category: 'public_safety' }, base)).toBe(false);
    for (const c of ['technology', 'transit', 'recall', 'events', 'pollen_uv'] as const) expect(checkinEligible({ severity: 5, category: c }, base)).toBe(false);
    expect(checkinEligible({ severity: 4, category: 'crime' }, { ...base, self: false })).toBe(false); // only a family member's place
    expect(checkinEligible({ severity: 4, category: 'crime' }, { ...base, delivery: 'feed' })).toBe(false);
    expect(checkinEligible({ severity: 4, category: 'crime' }, { ...base, backfill: true })).toBe(false);
    expect(checkinEligible({ severity: 4, category: 'crime' }, { ...base, ahead: true })).toBe(false);
    expect(checkinEligible({ severity: 4, category: 'crime' }, { ...base, kind: 'update' })).toBe(false);
  });

  it('a family member\'s answer names nobody\'s place and has no buttons', () => {
    const p = answerPush('u', randomUUID(), 'Mama', 'ok', 'de', new Date());
    expect(p).toMatchObject({ title: 'Mama: Alles okay', body: "Mama hat sich gemeldet: Mir geht's gut.", lat: 0, lon: 0, severity: 1, matchedPlace: null });
    const call = answerPush('u', randomUUID(), 'Mama', 'call_me', 'en', new Date());
    expect(call).toMatchObject({ title: 'Mama would like a call', severity: 4 });
    const msg = toExpoMessage({ token: 't', alert: call });
    expect(msg).not.toHaveProperty('categoryId');
    expect(msg.data).toEqual({ checkinId: call.id, url: 'heyokay://family' });
    expect(msg.interruptionLevel).toBe('time-sensitive');
    expect(describeSource('push:checkins')).toMatchObject({ category: 'system', name: '"Hey, okay?" reminders' });
  });
});

describe.each(storeBackends())('"Hey, okay?" check-ins ($name)', (backend) => {
  let store: Store, push: MemoryPushSender, app: ReturnType<typeof buildApi>, pipeline: Pipeline, clock: Date;
  beforeEach(async () => {
    store = await backend.make();
    push = new MemoryPushSender();
    clock = new Date();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: loadConfig({}), now: () => clock });
    app = buildApi({ store, pipeline, adminToken: 'a', runIngest: async () => ({}), mailer: new MemoryMailer(), errorSink: () => {} });
  });
  afterEach(async () => { await store.close(); });

  const call = (method: string, url: string, token?: string, payload?: unknown) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const userId = async (t: string) => (await call('GET', '/v1/me', t)).json().userId as string;
  /** A phone with a push token and no quiet hours (tests run at any time of day). */
  const device = async (pushToken: string | null) => {
    const t = (await call('POST', '/v1/devices', undefined, { pushToken, prefs: { quietHours: null, language: 'de' } })).json().token as string;
    return t;
  };
  const at = async (t: string, p: { lat: number; lon: number }) => { await store.updateLocation(await userId(t), p.lat, p.lon); };
  const family = async () => {
    const mama = await device('mama-phone'), kid = await device('kid-phone'), dad = await device(null); // dad uses the web
    await call('POST', '/v1/me/family', mama, { name: 'Mama' });
    for (const [t, name] of [[kid, 'Lena'], [dad, 'Papa']] as const) {
      const code = (await call('POST', '/v1/me/family/invite', mama, {})).json().code;
      await call('POST', '/v1/me/family/join', t, { code, name });
    }
    await at(kid, OSTKREUZ);
    await at(mama, MUENCHEN);
    await at(dad, MUENCHEN);
    clock = new Date(); // events happen after everyone joined
    return { mama, kid, dad };
  };
  const deliver = async (e: RiskEvent) => { await store.saveEvent(e); return pipeline.deliver((await store.getEvent(e.id))!); };
  const pushesTo = (token: string) => push.outbox.filter((m) => m.token === token);

  it('a severe event where she is asks her through the alert\'s own push; one tap tells the family', async () => {
    const { mama, kid, dad } = await family();
    await deliver(event());
    const [ask] = pushesTo('kid-phone');
    expect(pushesTo('kid-phone')).toHaveLength(1); // one notification, not two
    expect(ask.alert.checkin).toMatchObject({ kind: 'ask' });
    const msg = toExpoMessage(ask);
    expect(msg.categoryId).toBe('checkin');
    expect(msg.data).toEqual({ alertId: ask.alert.id, eventId: ask.alert.eventId, checkinId: ask.alert.checkin!.id, url: `heyokay://alert/${ask.alert.id}` });
    expect(pushesTo('mama-phone')).toEqual([]); // Mama is in München: nothing for her yet

    const list = (await call('GET', '/v1/me/checkins', kid)).json().checkins;
    expect(list).toEqual([{ id: ask.alert.checkin!.id, alertId: ask.alert.id, title: ask.alert.title, askedAt: clock.toISOString(), answer: null, answeredAt: null }]);
    expect((await call('GET', '/v1/me/checkins', mama)).json().checkins).toEqual([]);
    // Before she answers, the family knows nothing: not the event, not that she was asked.
    expect((await call('GET', '/v1/me/family', mama)).json().family.checkins).toEqual([]);

    const r = await call('POST', `/v1/me/checkins/${list[0].id}`, kid, { answer: 'ok' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ told: 2, checkin: { answer: 'ok' } });
    const told = pushesTo('mama-phone');
    expect(told).toHaveLength(1);
    expect(told[0].alert).toMatchObject({ title: 'Lena: Alles okay', lat: 0, lon: 0, matchedPlace: null });
    expect(JSON.stringify(told[0].alert)).not.toMatch(/Brand|Friedrichshain|52\.5/); // nothing about the event or the place

    const fam = (await call('GET', '/v1/me/family', dad)).json().family;
    const lena = fam.members.find((m: any) => m.name === 'Lena');
    expect(fam.checkins).toEqual([{ memberId: lena.id, answer: 'ok', answeredAt: expect.any(String) }]);

    // Same answer again tells nobody twice; changing it to "please call" does, and breaks through.
    await call('POST', `/v1/me/checkins/${list[0].id}`, kid, { answer: 'ok' });
    expect(pushesTo('mama-phone')).toHaveLength(1);
    await call('POST', `/v1/me/checkins/${list[0].id}`, kid, { answer: 'call_me' });
    expect(pushesTo('mama-phone').at(-1)!.alert).toMatchObject({ title: 'Lena bittet um einen Anruf', severity: 4 });
    expect((await call('GET', '/v1/me/family', dad)).json().family.checkins[0].answer).toBe('call_me');
  });

  it('nobody is asked outside a family, for a place someone else shared, or twice for one event', async () => {
    const alone = await device('alone-phone');
    await at(alone, OSTKREUZ);
    const { mama, kid } = await family();
    // Mama shares her home in Friedrichshain; she is away in München.
    const home = (await call('POST', '/v1/me/places', mama, { label: 'Zuhause', ...OSTKREUZ, radiusM: 500 })).json().place;
    await call('PATCH', `/v1/me/places/${home.id}`, mama, { shared: true });
    await at(kid, MUENCHEN);
    const e = event();
    await deliver(e);
    expect(pushesTo('alone-phone')[0].alert.checkin).toBeUndefined(); // no family: no one to tell
    expect(pushesTo('kid-phone')[0].alert).toMatchObject({ matchedPlace: 'Zuhause (Mama)' });
    expect(pushesTo('kid-phone')[0].alert.checkin).toBeUndefined(); // it's Mama's place, not where Lena is
    expect(pushesTo('mama-phone')[0].alert.checkin).toMatchObject({ kind: 'ask' }); // her own place
    expect(toExpoMessage(pushesTo('alone-phone')[0]).categoryId).toBe('alert');

    // A new revision of the same event doesn't ask again.
    await store.saveEvent({ ...(await store.getEvent(e.id))!, revision: 2, severity: 5 });
    await pipeline.deliver((await store.getEvent(e.id))!);
    expect((await call('GET', '/v1/me/checkins', mama)).json().checkins).toHaveLength(1);

    // Moderate events, and transit, never ask.
    await deliver(event({ severity: 3 }));
    await deliver(event({ category: 'transit', severity: 4 }));
    expect((await call('GET', '/v1/me/checkins', mama)).json().checkins).toHaveLength(1);
  });

  it('one gentle reminder after a while, not during quiet hours, not once it\'s over', async () => {
    const { kid, mama } = await family();
    const e = event();
    await deliver(e);
    const id = (await call('GET', '/v1/me/checkins', kid)).json().checkins[0].id as string;

    expect(await pipeline.sendCheckinReminders()).toEqual({ due: 0, sent: 0 }); // too early
    clock = new Date(clock.getTime() + (CHECKIN_REMIND_MIN + 1) * 60_000);
    // During her quiet hours: wait.
    const kidUser = (await store.getUser(await userId(kid)))!;
    await store.updatePrefs(kidUser.id, { ...kidUser.prefs, quietHours: { start: '00:00', end: '23:59' }, timezone: 'UTC' });
    expect(await pipeline.sendCheckinReminders()).toEqual({ due: 1, sent: 0 });
    await store.updatePrefs(kidUser.id, { ...kidUser.prefs, quietHours: null });

    expect(await pipeline.sendCheckinReminders()).toEqual({ due: 1, sent: 1 });
    const reminder = pushesTo('kid-phone').at(-1)!;
    expect(reminder.alert).toMatchObject({ id, title: 'Alles okay?', severity: 3, checkin: { id, kind: 'reminder' } });
    expect(reminder.alert.body).toContain('Ein Tipp sagt deiner Familie Bescheid');
    const msg = toExpoMessage(reminder);
    expect(msg.categoryId).toBe('checkin');
    expect(msg.data.alertId).toBe(reminder.alert.checkin!.alertId); // opens the alert, not the check-in id
    expect(msg.interruptionLevel).toBe('active');
    // Only once; and the family hears nothing about it.
    expect(await pipeline.sendCheckinReminders()).toEqual({ due: 0, sent: 0 });
    expect(pushesTo('mama-phone')).toEqual([]);
    expect((await call('GET', '/v1/me/family', mama)).json().family.checkins).toEqual([]);

    // An event that is already over gets no reminder.
    await at(mama, OSTKREUZ);
    const over = event({}, clock);
    await deliver(over);
    await store.saveEvent({ ...(await store.getEvent(over.id))!, endsAt: new Date(clock.getTime() + 60_000).toISOString() });
    clock = new Date(clock.getTime() + (CHECKIN_REMIND_MIN + 1) * 60_000);
    expect(await pipeline.sendCheckinReminders()).toMatchObject({ sent: 0 });
  });

  it('answers only your own check-ins; leaving the family hides them; erasure and retention delete them', async () => {
    const { kid, mama, dad } = await family();
    await deliver(event());
    const id = (await call('GET', '/v1/me/checkins', kid)).json().checkins[0].id as string;
    expect((await call('POST', `/v1/me/checkins/${id}`, mama, { answer: 'ok' })).statusCode).toBe(404);
    expect((await call('POST', `/v1/me/checkins/${randomUUID()}`, kid, { answer: 'ok' })).statusCode).toBe(404);
    expect((await call('POST', `/v1/me/checkins/${id}`, kid, { answer: 'help' })).statusCode).toBe(400);
    expect((await call('POST', `/v1/me/checkins/${id}`, kid, { answer: 'ok', where: 'x' })).statusCode).toBe(400);
    expect((await call('GET', '/v1/me/checkins')).statusCode).toBe(401);

    await call('POST', `/v1/me/checkins/${id}`, kid, { answer: 'ok' });
    // Lena leaves and starts her own family: the new family doesn't learn about the time before.
    await call('DELETE', '/v1/me/family', kid);
    expect((await call('GET', '/v1/me/checkins', kid)).json().checkins).toEqual([]);
    expect((await call('GET', '/v1/me/family', dad)).json().family.checkins).toEqual([]);
    await call('POST', '/v1/me/family', kid, { name: 'Lena' });
    const friend = await device('friend-phone');
    await call('POST', '/v1/me/family/join', friend, { code: (await call('POST', '/v1/me/family/invite', kid, {})).json().code, name: 'Sam' });
    expect((await call('GET', '/v1/me/family', friend)).json().family.checkins).toEqual([]);

    const later = new Date(Date.now() + 31 * 86_400_000).toISOString();
    expect((await store.purgeExpired(later)).checkins).toBe(1);
    await at(kid, OSTKREUZ); // retention also cleared the month-old location
    await deliver(event());
    const kidId = await userId(kid);
    expect(await store.checkinsForUser(kidId, new Date(0).toISOString())).toHaveLength(1);
    await call('DELETE', '/v1/me', kid);
    expect(await store.checkinsForUser(kidId, new Date(0).toISOString())).toEqual([]);
  });

  it('two workers never send the same reminder', async () => {
    const { kid } = await family();
    await deliver(event());
    clock = new Date(clock.getTime() + (CHECKIN_REMIND_MIN + 1) * 60_000);
    const id = (await call('GET', '/v1/me/checkins', kid)).json().checkins[0].id as string;
    const wins = await Promise.all(Array.from({ length: 6 }, () => store.markCheckinReminded(id, clock.toISOString())));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});
