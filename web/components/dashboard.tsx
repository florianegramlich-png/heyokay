'use client';

import { Card, CardContent } from '@/components/ui/card';
import { CategoryIcon } from '@/components/category-icon';
import { useI18n } from '@/lib/i18n';
import type { Dashboard as Data, Status } from '@/lib/dashboard';
import type { Alert, Category, Severity } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Same colours as the phone app (app/src/lib/theme.ts). */
export const SEVERITY_HEX: Record<Severity, string> = { 1: '#94A3B8', 2: '#22D3EE', 3: '#FBBF24', 4: '#FB923C', 5: '#F87171' };
const CATEGORY_HEX: Record<Category, string> = {
  weather: '#38BDF8', crime: '#A5B4FC', transit: '#22D3EE', public_safety: '#FDBA74',
  health: '#34D399', infrastructure: '#C4B5FD', technology: '#F0ABFC', recall: '#BEF264',
};
const CYAN = '#22D3EE';
const statusColor = (status: Status, highest: Severity | null) => (status === 'calm' ? CYAN : SEVERITY_HEX[highest ?? 1]);

/**
 * Overview at the top of "Now", like the phone app's: status card with a level meter, a tile per
 * topic, and a 24-hour line. Real alerts only; no risk percentages or area scores.
 */
export function Dashboard({ data, onOpen }: { data: Data; onOpen: (a: Alert) => void }) {
  const { t, categoryLabel, severityLabel, locale } = useI18n();
  const accent = statusColor(data.status, data.highest);
  const clock = (iso: string | number) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-4">
      {/* Status */}
      <Card className="relative overflow-hidden" style={{ borderColor: `${accent}73` }}>
        <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-cyan-400 to-purple-500" aria-hidden />
        <CardContent className="space-y-1 py-5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{t('dash.title')}</p>
          <h2 className="text-3xl font-bold" style={{ color: accent }}>{t(`dash.status.${data.status}`)}</h2>
          <p className="text-sm text-foreground/85">
            {data.highest === null ? t('dash.status.calmText') : t('dash.status.text', { n: data.current, level: severityLabel(data.highest) })}
          </p>
          <div
            className="flex gap-1 pt-3"
            role="img"
            aria-label={`${t('dash.meter')}: ${data.highest ? severityLabel(data.highest) : t('dash.quiet')}`}
          >
            {([1, 2, 3, 4, 5] as Severity[]).map((n) => (
              <div key={n} className="h-1.5 flex-1 rounded-full"
                style={{ backgroundColor: data.highest && n <= data.highest ? SEVERITY_HEX[n] : 'rgba(255,255,255,0.10)' }} />
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">{t('dash.meter')}</p>
        </CardContent>
      </Card>

      {/* Topics */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t('dash.topics')}</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {data.tiles.map((tile) => {
            const active = tile.count > 0;
            return (
              <button
                key={tile.category}
                type="button"
                disabled={!tile.top}
                onClick={() => tile.top && onOpen(tile.top)}
                className={cn('min-h-[92px] rounded-xl border bg-card p-3 text-left transition', tile.top ? 'hover:bg-white/5' : 'cursor-default')}
                style={{ borderColor: active ? `${CATEGORY_HEX[tile.category]}66` : undefined }}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <CategoryIcon category={tile.category} className="h-4 w-4" />
                  <span className="line-clamp-2">{categoryLabel(tile.category)}</span>
                </span>
                <span className={cn('mt-2 block', active ? 'text-xl font-bold' : 'text-sm text-muted-foreground')}>
                  {active ? t('dash.active', { n: tile.count }) : t('dash.quiet')}
                </span>
                {tile.highest ? (
                  <span className="block text-xs font-semibold" style={{ color: SEVERITY_HEX[tile.highest] }}>{severityLabel(tile.highest)}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      {/* Next 24 hours */}
      <Card><CardContent className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">{t('dash.next24')}</h2>
          <span className="text-xs text-muted-foreground">
            {data.next24.length ? t('dash.next24.count', { n: data.next24.length }) : t('dash.next24.none')}
          </span>
        </div>
        <div className="relative flex h-5 items-center">
          <div className="h-1 w-full rounded-full bg-gradient-to-r from-cyan-400/35 to-purple-500/35" />
          {data.next24.map(({ alert, at }) => (
            <button
              key={alert.id}
              type="button"
              onClick={() => onOpen(alert)}
              aria-label={alert.title}
              className="absolute -ml-[7px] h-3.5 w-3.5 rounded-full border-2 border-background"
              style={{ left: `${Math.min(Math.max(at, 0), 1) * 100}%`, backgroundColor: SEVERITY_HEX[alert.severity] }}
            />
          ))}
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{t('dash.nowMark')}</span>
          <span>{clock(Date.now() + 12 * 3600_000)}</span>
          <span>+24 h</span>
        </div>
        {data.next24.slice(0, 3).map(({ alert }) => (
          <button key={alert.id} type="button" onClick={() => onOpen(alert)} className="flex w-full items-center gap-2 text-left">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: SEVERITY_HEX[alert.severity] }} />
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{clock(alert.startsAt!)}</span>
            <span className="truncate text-sm">{alert.title}</span>
          </button>
        ))}
      </CardContent></Card>
    </div>
  );
}
