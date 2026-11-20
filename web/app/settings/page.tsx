'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { CategoryIcon } from '@/components/category-icon';
import { api } from '@/lib/api';
import { session } from '@/lib/session';
import { geocodeAddress } from '@/lib/location';
import { setLanguage, useI18n, type Lang } from '@/lib/i18n';
import { LanguageSelect } from '@/components/language-select';
import { AccountSection } from '@/components/account-section';
import { useDevice } from '@/lib/use-device';
import { CATEGORIES, type Category, type SavedPlace, type TechService, type UserPrefs } from '@/lib/types';
import { followsService, toggleService } from '@/lib/services';
import { cn } from '@/lib/utils';

const LIMITS = [1, 3, 5, 10];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card><CardContent className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </CardContent></Card>
  );
}

export default function Settings() {
  const ready = useDevice();
  const router = useRouter();
  const { t, lang, categoryLabel, categoryHint } = useI18n();
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [placeMsg, setPlaceMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [services, setServices] = useState<TechService[]>([]);

  useEffect(() => {
    if (!ready) return;
    api.me().then((m) => { setPrefs(m.prefs); setPlaces(m.places); setAccount(m.account?.email ?? null); }).catch(() => {});
    api.services().then((r) => setServices(r.services)).catch(() => {});
  }, [ready]);

  const save = async (patch: Partial<UserPrefs>) => {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, ...patch });
    try { setPrefs((await api.updatePrefs(patch)).prefs); } catch { setPrefs(before); }
  };

  const toggleCategory = (c: Category) =>
    prefs && save({ categories: prefs.categories.includes(c) ? prefs.categories.filter((x) => x !== c) : [...prefs.categories, c] });

  const chooseLanguage = (l: Lang) => { setLanguage(l); save({ language: l }); };

  const addPlace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !address.trim()) return;
    setAdding(true); setPlaceMsg(t('web.places.geocoding'));
    try {
      const hit = await geocodeAddress(address.trim());
      if (!hit) { setPlaceMsg(t('set.places.notFound')); return; }
      const { place } = await api.addPlace(label.trim().slice(0, 40), hit.lat, hit.lon);
      setPlaces((ps) => [...ps, place]);
      setLabel(''); setAddress(''); setPlaceMsg(null);
    } catch {
      setPlaceMsg(t('set.places.saveFailed'));
    } finally {
      setAdding(false);
    }
  };

  const removePlace = async (id: string) => {
    setPlaces((ps) => ps.filter((p) => p.id !== id));
    await api.deletePlace(id).catch(() => api.me().then((m) => setPlaces(m.places)));
  };

  const deleteEverything = async () => {
    await api.deleteAccount().catch(() => {});
    session.clear();
    router.replace('/onboarding');
  };

  if (!ready) return null;
  if (!prefs) return <p className="text-sm text-muted-foreground">{t('set.loading')}</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('web.nav.settings')}</h1>

      <AccountSection email={account} onChanged={(n) => { setAccount(n.email); setPrefs(n.prefs); setPlaces(n.places); }} />

      <Section title={t('set.language')}>
        <LanguageSelect onChange={chooseLanguage} />
      </Section>

      <Section title={t('set.topics')}>
        <ul className="space-y-2">
          {CATEGORIES.map((c) => (
            <li key={c}>
              <label className="flex cursor-pointer items-center gap-3">
                <CategoryIcon category={c} />
                <span className="flex-1">
                  <span className="block text-sm">{categoryLabel(c)}</span>
                  <span className="block text-xs text-muted-foreground">{categoryHint(c)}</span>
                </span>
                <Switch checked={prefs.categories.includes(c)} onCheckedChange={() => toggleCategory(c)} aria-label={categoryLabel(c)} />
              </label>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t('onb.cat.always')}</p>
      </Section>

      {prefs.categories.includes('technology') && services.length > 0 && (
        <Section title={t('set.services')}>
          <p className="text-xs text-muted-foreground">{t('set.services.hint')}</p>
          <div className="flex flex-wrap gap-2">
            {[{ key: '*', name: t('set.services.all') }, ...services].map((svc) => {
              const on = svc.key === '*' ? !prefs.techServices : !!prefs.techServices && followsService(prefs.techServices, svc.key);
              return (
                <button
                  key={svc.key}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => save({ techServices: svc.key === '*' ? null : toggleService(prefs.techServices, svc.key) })}
                  className={cn('rounded-full border px-3.5 py-1.5 text-sm font-medium', on ? 'border-purple-500 bg-purple-500/20 text-purple-100' : 'border-border text-muted-foreground')}
                >{svc.name}</button>
              );
            })}
          </div>
        </Section>
      )}

      <Section title={t('set.notifications')}>
        <label className="flex cursor-pointer items-center gap-3">
          <span className="flex-1">
            <span className="block text-sm">{t('set.quiet')}</span>
            <span className="block text-xs text-muted-foreground">{t('set.quiet.hint')}</span>
          </span>
          <Switch checked={!!prefs.quietHours} onCheckedChange={(on) => save({ quietHours: on ? { start: '22:00', end: '07:00' } : null })} aria-label={t('set.quiet')} />
        </label>
        <div>
          <p className="mb-2 text-sm">{t('set.limit')}</p>
          <div className="flex gap-2">
            {LIMITS.map((n) => (
              <button
                key={n}
                onClick={() => save({ dailyLimit: n })}
                aria-pressed={prefs.dailyLimit === n}
                className={cn('h-9 w-12 rounded-lg border text-sm', prefs.dailyLimit === n ? 'border-purple-500 bg-purple-500/20 text-purple-200' : 'border-border text-muted-foreground')}
              >{n}</button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('set.limit.hint')}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t('web.now.webNote')}</p>
      </Section>

      <Section title={t('set.places')}>
        <ul className="space-y-2">
          {places.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-cyan-400" aria-hidden />
              <span className="flex-1">{p.label} <span className="text-xs text-muted-foreground">· {t('web.places.radius', { m: p.radiusM })}</span></span>
              <Button variant="ghost" size="sm" onClick={() => removePlace(p.id)}>{t('set.places.remove')}</Button>
            </li>
          ))}
        </ul>
        <form onSubmit={addPlace} className="space-y-2">
          <Input placeholder={t('set.places.name')} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} aria-label={t('set.places.name')} />
          <Input placeholder={t('set.places.address')} value={address} onChange={(e) => setAddress(e.target.value)} aria-label={t('set.places.address')} />
          <Button type="submit" variant="outline" className="w-full" disabled={adding || !label.trim() || !address.trim()}>{t('set.places.add')}</Button>
          {placeMsg && <p className="text-xs text-muted-foreground">{placeMsg}</p>}
          <p className="text-[11px] text-muted-foreground">{t('web.places.attribution')}</p>
        </form>
      </Section>

      <Section title={t('set.privacy')}>
        <p className="text-sm text-muted-foreground">{t('set.privacy.text')}</p>
        <label className="flex cursor-pointer items-start gap-3">
          <Switch checked={!!prefs.insightsConsent} onCheckedChange={(on) => save({ insightsConsent: on })} aria-label={t('consent.insights.label')} />
          <span><span className="block text-sm font-medium">{t('consent.insights.label')}</span><span className="block text-xs text-muted-foreground">{t('consent.insights.hint')}</span></span>
        </label>
        <Button variant="destructive" className="w-full" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" aria-hidden />{t('set.delete')}</Button>
      </Section>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent closeLabel={t('set.delete.cancel')}>
          <DialogTitle className="text-lg font-semibold">{t('set.delete.title')}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{t('set.delete.text')}</DialogDescription>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setConfirmDelete(false)}>{t('set.delete.cancel')}</Button>
            <Button variant="destructive" className="flex-1" onClick={deleteEverything}>{t('set.delete.confirm')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
