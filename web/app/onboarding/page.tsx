'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { CategoryIcon } from '@/components/category-icon';
import { api } from '@/lib/api';
import { session } from '@/lib/session';
import { currentPosition } from '@/lib/location';
import { useI18n } from '@/lib/i18n';
import { CATEGORIES, DEFAULT_PREFS, type Category } from '@/lib/types';

type Step = 'value' | 'location' | 'categories' | 'consent';

/**
 * Same steps as the phone app, minus notifications (the browser gets none):
 * value → location → categories → consent. The device registers anonymously at the end.
 */
export default function Onboarding() {
  const router = useRouter();
  const { t, lang, categoryLabel, categoryHint } = useI18n();
  const [step, setStep] = useState<Step>('value');
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [categories, setCategories] = useState<Category[]>(DEFAULT_PREFS.categories);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => { if (session.getToken()) router.replace('/now'); }, [router]);

  const askLocation = async () => {
    setLocating(true);
    const r = await currentPosition();
    setLocating(false);
    if (r.ok) setCoords({ lat: r.lat, lon: r.lon });
    setStep('categories');
  };

  const finish = async () => {
    setBusy(true); setError(false);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
      const { token } = await api.register({ ...DEFAULT_PREFS, categories, language: lang, timezone });
      session.setToken(token);
      // First sync fills the feed with what's going on, without counting as alerts.
      if (coords) await api.sendLocation(coords.lat, coords.lon, true).catch(() => {});
      router.replace('/now');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (c: Category) => setCategories((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  return (
    <div className="space-y-4 pt-6">
      {step === 'value' && (
        <Card><CardContent className="space-y-4 p-6">
          <Sparkles className="h-8 w-8 text-purple-400" aria-hidden />
          <h1 className="text-2xl font-semibold">{t('onb.value.title')}</h1>
          <p className="text-muted-foreground">{t('onb.value.text')}</p>
          <Button size="lg" className="w-full" onClick={() => setStep('location')}>{t('onb.value.cta')}</Button>
        </CardContent></Card>
      )}

      {step === 'location' && (
        <Card><CardContent className="space-y-4 p-6">
          <MapPin className="h-8 w-8 text-cyan-400" aria-hidden />
          <h1 className="text-2xl font-semibold">{t('onb.location.title')}</h1>
          <p className="text-muted-foreground">{t('onb.location.text')}</p>
          <p className="text-sm text-muted-foreground">{t('web.onb.locationWeb')}</p>
          <Button size="lg" className="w-full" onClick={askLocation} disabled={locating}>{locating ? t('web.now.locating') : t('onb.location.cta')}</Button>
          <Button variant="ghost" className="w-full" onClick={() => setStep('categories')}>{t('onb.later')}</Button>
        </CardContent></Card>
      )}

      {step === 'categories' && (
        <Card><CardContent className="space-y-4 p-6">
          <h1 className="text-2xl font-semibold">{t('onb.cat.title')}</h1>
          <p className="text-muted-foreground">{t('onb.cat.text')}</p>
          <ul className="space-y-2">
            {CATEGORIES.map((c) => (
              <li key={c}>
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border/50 p-3">
                  <CategoryIcon category={c} />
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{categoryLabel(c)}</span>
                    <span className="block text-xs text-muted-foreground">{categoryHint(c)}</span>
                  </span>
                  <Switch checked={categories.includes(c)} onCheckedChange={() => toggle(c)} aria-label={categoryLabel(c)} />
                </label>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('onb.cat.always')}</p>
          <Button size="lg" className="w-full" onClick={() => setStep('consent')}>{t('onb.next')}</Button>
        </CardContent></Card>
      )}

      {step === 'consent' && (
        <Card><CardContent className="space-y-4 p-6">
          <ShieldCheck className="h-8 w-8 text-emerald-400" aria-hidden />
          <h1 className="text-2xl font-semibold">{t('onb.consent.title')}</h1>
          <p className="text-muted-foreground">{t('onb.consent.text')}</p>
          {error && <p role="alert" className="text-sm text-orange-300">{t('onb.error')}</p>}
          <Button size="lg" className="w-full" onClick={finish} disabled={busy}>{busy ? t('onb.consent.busy') : t('onb.consent.cta')}</Button>
        </CardContent></Card>
      )}
    </div>
  );
}
