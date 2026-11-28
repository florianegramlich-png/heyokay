'use client';

import { useCallback, useEffect, useState } from 'react';
import { LocateFixed, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertCard } from '@/components/alert-card';
import { AlertDialog } from '@/components/alert-dialog';
import { CheckinCard } from '@/components/checkin-card';
import { CategoryIcon } from '@/components/category-icon';
import { Dashboard } from '@/components/dashboard';
import { api } from '@/lib/api';
import { aheadAlerts, byCategory } from '@/lib/feed';
import { buildDashboard } from '@/lib/dashboard';
import { checkinForAlert, checkinToShow, type Checkin } from '@/lib/family';
import { currentPosition } from '@/lib/location';
import { useDevice } from '@/lib/use-device';
import { useI18n } from '@/lib/i18n';
import { CATEGORIES, type Alert, type Category, type Feedback } from '@/lib/types';

/**
 * "Jetzt": what's going on near you and your places right now, grouped by category.
 * Starts with the overview (status, topic tiles, next 24 hours), like the phone app, then the
 * alerts. No risk scores, no area ratings.
 */
export default function Now() {
  const ready = useDevice();
  const { t, categoryLabel, locale } = useI18n();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Alert | null>(null);
  const [locating, setLocating] = useState(false);
  const [location, setLocation] = useState<'unknown' | 'on' | 'off' | 'denied'>('unknown');
  /** Topics the person follows (dashboard tiles); all of them until /v1/me answers. */
  const [followed, setFollowed] = useState<readonly Category[]>(CATEGORIES);
  /** "Hey, okay?" check-ins of the last day (only for people in a family). */
  const [checkins, setCheckins] = useState<Checkin[]>([]);

  const load = useCallback(async () => {
    try {
      const [{ alerts }, me, cis] = await Promise.all([api.alerts(), api.me().catch(() => null), api.checkins().catch(() => null)]);
      if (me) setFollowed(me.prefs.categories);
      if (cis) setCheckins(cis.checkins);
      setAlerts(alerts);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  const locate = useCallback(async () => {
    setLocating(true);
    const r = await currentPosition();
    if (r.ok) {
      await api.sendLocation(r.lat, r.lon).catch(() => {});
      setLocation('on');
    } else {
      setLocation(r.reason === 'denied' ? 'denied' : 'off');
    }
    setLocating(false);
    await load();
  }, [load]);

  useEffect(() => {
    if (!ready) return;
    load();
    // Refresh the location only if the browser already allows it; never prompt on page load.
    navigator.permissions?.query({ name: 'geolocation' as PermissionName })
      .then((p) => (p.state === 'granted' ? locate() : setLocation(p.state === 'denied' ? 'denied' : 'off')))
      .catch(() => setLocation('off'));
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [ready, load, locate]);

  const markFeedback = (id: string, f: Feedback) => setAlerts((as) => as?.map((a) => (a.id === id ? { ...a, feedback: f } : a)) ?? null);

  if (!ready) return null;
  const groups = alerts ? byCategory(alerts) : [];
  const ahead = alerts ? aheadAlerts(alerts) : [];
  const dashboard = alerts ? buildDashboard(alerts, followed) : null;
  const checkin = checkinToShow(checkins);
  const answered = (next: Checkin) => setCheckins((cs) => cs.map((c) => (c.id === next.id ? next : c)));

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t('web.now.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('web.now.subtitle')}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} aria-label={t('web.now.refresh')}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {(location === 'off' || location === 'denied') && (
        <Card><CardContent className="flex items-center gap-3 p-3 text-sm">
          <LocateFixed className="h-5 w-5 shrink-0 text-cyan-400" aria-hidden />
          <span className="flex-1 text-muted-foreground">{location === 'denied' ? t('web.now.locationDenied') : t('web.now.locationOff')}</span>
          {location === 'off' && <Button size="sm" variant="outline" onClick={locate} disabled={locating}>{locating ? t('web.now.locating') : t('feed.noLocation.cta')}</Button>}
        </CardContent></Card>
      )}

      {error && !alerts && (
        <Card><CardContent className="p-6 text-center">
          <p className="font-medium">{t('feed.error.title')}</p>
          <p className="text-sm text-muted-foreground">{t('feed.error.text')}</p>
        </CardContent></Card>
      )}

      {checkin && <CheckinCard key={`${checkin.id}:${checkin.answer}`} checkin={checkin} onAnswered={answered} />}

      {dashboard && <Dashboard data={dashboard} onOpen={setOpen} />}


      {groups.map((g) => (
        <section key={g.category} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <CategoryIcon category={g.category} />
            {categoryLabel(g.category)}
            <span className="text-xs text-muted-foreground">· {t('web.now.count', { n: g.alerts.length })}</span>
          </h2>
          {g.alerts.map((a) => <AlertCard key={a.id} alert={a} onOpen={setOpen} />)}
        </section>
      ))}

      {ahead.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{t('feed.ahead')}</h2>
          {ahead.map((a) => (
            <div key={a.id} className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('feed.ahead.from', { time: new Date(a.startsAt!).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}</p>
              <AlertCard alert={a} onOpen={setOpen} showCategory />
            </div>
          ))}
        </section>
      )}

      <p className="pt-2 text-center text-xs text-muted-foreground">{t('web.now.webNote')}</p>
      <AlertDialog alert={open} onClose={() => setOpen(null)} onFeedback={markFeedback} checkin={open ? checkinForAlert(checkins, open.id) : null} onCheckin={answered} />
    </div>
  );
}
