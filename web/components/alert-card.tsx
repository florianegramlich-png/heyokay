'use client';

import { ChevronRight, MapPin } from 'lucide-react';
import type { Alert } from '@/lib/types';
import { SEVERITY_STYLE } from '@/lib/feed';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CategoryIcon } from './category-icon';

export function AlertCard({ alert, onOpen, showCategory = false }: { alert: Alert; onOpen: (a: Alert) => void; showCategory?: boolean }) {
  const { t, severityLabel, timeAgo, categoryLabel } = useI18n();
  const muted = alert.ended || alert.kind === 'all_clear';
  return (
    <button
      onClick={() => onOpen(alert)}
      className={cn('w-full rounded-xl border border-border/50 bg-background/40 p-4 text-left backdrop-blur-sm transition-colors hover:bg-background/60', muted && 'opacity-70')}
    >
      <div className="flex items-start gap-3">
        {showCategory && <CategoryIcon category={alert.category} className="mt-0.5 h-5 w-5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            {alert.kind === 'all_clear' ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-emerald-300">{t('alert.kind.allClear')}</span>
            ) : (
              <span className={cn('rounded-full border px-2 py-0.5', SEVERITY_STYLE[alert.severity])}>{severityLabel(alert.severity)}</span>
            )}
            {alert.kind === 'update' && <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">{t('alert.kind.update')}</span>}
            {alert.ended && alert.kind !== 'all_clear' && <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">{t('alert.ended')}</span>}
            {alert.official && <span className="rounded-full border border-cyan-500/30 px-2 py-0.5 text-cyan-300">{t('alert.official')}</span>}
            {showCategory && <span className="text-muted-foreground">{categoryLabel(alert.category)}</span>}
          </div>
          <p className="font-medium leading-snug">{alert.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{alert.body}</p>
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            {alert.matchedPlace && <><MapPin className="h-3 w-3" aria-hidden />{alert.matchedPlace} · </>}
            {alert.sourceName} · {timeAgo(alert.createdAt)}
          </p>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
    </button>
  );
}
