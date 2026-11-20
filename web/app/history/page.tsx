'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AlertCard } from '@/components/alert-card';
import { AlertDialog } from '@/components/alert-dialog';
import { CategoryIcon } from '@/components/category-icon';
import { api } from '@/lib/api';
import { groupByDay } from '@/lib/history';
import { useDevice } from '@/lib/use-device';
import { useI18n } from '@/lib/i18n';
import { CATEGORIES, type Alert, type Category, type Feedback } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Searchable history (PRD 5.3), like the phone app's: one entry per incident in its latest state,
 * by day. Search by words ("S-Bahn", a street, a saved place) and narrow by topic.
 */
export default function History() {
  const ready = useDevice();
  const { t, categoryLabel, locale } = useI18n();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Alert | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!ready) return;
    const mine = ++seq.current;
    // Wait for a pause in typing; only the latest answer counts.
    const timer = setTimeout(async () => {
      try {
        const res = await api.history({ q: q.trim() || undefined, category: category ?? undefined });
        if (mine === seq.current) { setAlerts(res.alerts); setError(false); }
      } catch {
        if (mine === seq.current) setError(true);
      }
    }, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [ready, q, category]);

  const markFeedback = (id: string, f: Feedback) => setAlerts((as) => as?.map((a) => (a.id === id ? { ...a, feedback: f } : a)) ?? null);
  if (!ready) return null;

  const groups = alerts ? groupByDay(alerts) : [];
  const dayLabel = (g: (typeof groups)[number]) =>
    g.label === 'today' ? t('history.today') : g.label === 'yesterday' ? t('history.yesterday')
      : g.date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const chip = (key: string, label: React.ReactNode, active: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium',
        active ? 'border-purple-500 bg-purple-500/20 text-foreground' : 'border-border text-muted-foreground')}
    >{label}</button>
  );

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">{t('web.history.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('web.history.subtitle')}</p>
      </div>
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('history.search')} aria-label={t('history.search')} />
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {chip('all', t('history.all'), category === null, () => setCategory(null))}
        {CATEGORIES.map((c) => chip(c, <><CategoryIcon category={c} className="h-3.5 w-3.5" />{categoryLabel(c)}</>, category === c, () => setCategory(category === c ? null : c)))}
      </div>
      {error && <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">{t('history.offline')}</CardContent></Card>}
      {alerts?.length === 0 && !error && (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">{q.trim() || category ? t('history.none') : t('history.empty')}</CardContent></Card>
      )}
      {groups.map((g) => (
        <section key={g.key} className="space-y-2">
          <h2 className="pt-1 text-sm font-medium text-muted-foreground">{dayLabel(g)}</h2>
          {g.alerts.map((a) => <AlertCard key={a.id} alert={a} onOpen={setOpen} showCategory />)}
        </section>
      ))}
      <AlertDialog alert={open} onClose={() => setOpen(null)} onFeedback={markFeedback} />
    </div>
  );
}
