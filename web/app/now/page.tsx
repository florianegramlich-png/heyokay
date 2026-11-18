'use client';

import { useCallback, useEffect, useState } from 'react';
import { LocateFixed, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertCard } from '@/components/alert-card';
import { AlertDialog } from '@/components/alert-dialog';
import { CategoryIcon } from '@/components/category-icon';
import { api } from '@/lib/api';
import { byCategory } from '@/lib/feed';
import { currentPosition } from '@/lib/location';
import { useDevice } from '@/lib/use-device';
import { useI18n } from '@/lib/i18n';
import type { Alert, Feedback } from '@/lib/types';

/**
 * "Jetzt": what's going on near you and your places right now, grouped by category.
 * Replaces the v0 risk-score dashboard: no scores, no area ratings, just current alerts,
 * and "Alles okay." when there is nothing.
 */
export default function Now() {
  const ready = useDevice();
  const { t, categoryLabel } = useI18n();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Alert | null>(null);
  const [locating, setLocating] = useState(false);
  const [location, setLocation] = useState<'unknown' | 'on' | 'off' | 'denied'>('unknown');

  const load = useCallback(async () => {
    try {
      setAlerts((await api.alerts()).alerts);
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

      {alerts && groups.length === 0 && (
        <Card><CardContent className="space-y-2 p-8 text-center">
          <p className="bg-gradient-to-r from-cyan-400 to-purple-500 bg-clip-text text-2xl font-semibold text-transparent">{t('feed.empty.title')}</p>
          <p className="text-sm text-muted-foreground">{t('feed.empty.text')}</p>
        </CardContent></Card>
      )}

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

      <p className="pt-2 text-center text-xs text-muted-foreground">{t('web.now.webNote')}</p>
      <AlertDialog alert={open} onClose={() => setOpen(null)} onFeedback={markFeedback} />
    </div>
  );
}
