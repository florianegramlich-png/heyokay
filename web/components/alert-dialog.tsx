'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api } from '@/lib/api';
import type { Alert, AlertDetail, Feedback } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { CategoryIcon } from './category-icon';

/** Alert detail: what to do, summary, sources, AI note and the relevance question (feeds ranking). */
export function AlertDialog({ alert, onClose, onFeedback }: { alert: Alert | null; onClose: () => void; onFeedback: (id: string, f: Feedback) => void }) {
  const { t, locale, categoryLabel } = useI18n();
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [gone, setGone] = useState(false);
  const [given, setGiven] = useState<Feedback | null>(null);

  useEffect(() => {
    setDetail(null); setGone(false); setGiven(alert?.feedback ?? null);
    if (!alert) return;
    let live = true;
    api.alert(alert.id).then((d) => live && setDetail(d)).catch(() => live && setGone(true));
    return () => { live = false; };
  }, [alert]);

  const rate = async (f: Feedback) => {
    if (!alert) return;
    setGiven(f);
    onFeedback(alert.id, f);
    await api.feedback(alert.id, f).catch(() => setGiven(null));
  };

  return (
    <Dialog open={!!alert} onOpenChange={(o) => !o && onClose()}>
      {alert && (
        <DialogContent closeLabel={t('web.detail.close')}>
          <div className="flex items-center gap-2 pr-6 text-sm text-muted-foreground">
            <CategoryIcon category={alert.category} />
            {categoryLabel(alert.category)}
            {detail?.endsAt && !alert.ended && (
              <span>· {t('alert.until', { time: new Date(detail.endsAt).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}</span>
            )}
          </div>
          <DialogTitle className="text-lg font-semibold leading-snug">{alert.title}</DialogTitle>
          <DialogDescription className="text-sm text-foreground/90">{alert.body}</DialogDescription>
          {alert.matchedPlace && <p className="text-xs text-muted-foreground">{t('alert.affects', { place: alert.matchedPlace })}</p>}
          {(alert.ended || alert.kind === 'all_clear') && <p className="text-sm text-emerald-300">{t('alert.endedNote')}</p>}
          {gone && <p className="text-sm text-muted-foreground">{t('alert.gone')}</p>}

          <section className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-3">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-cyan-300">{t('alert.whatToDo')}</h3>
            <p className="text-sm">{alert.action}</p>
          </section>

          {detail?.summary && detail.summary.trim() !== alert.body.trim() && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('alert.summary')}</h3>
              <p className="text-sm text-foreground/90">{detail.summary}</p>
            </section>
          )}

          {!!detail?.sources.length && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('alert.sources')}</h3>
              <ul className="space-y-1 text-sm">
                {detail.sources.map((s, i) => (
                  <li key={i}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-purple-300 hover:underline">
                        {s.sourceName}{s.official ? ` · ${t('alert.official')}` : ''}<ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    ) : (
                      <span>{s.sourceName}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {alert.aiWritten && <p className="text-xs text-muted-foreground">{t('alert.aiWritten')} · {t('alert.aiNote')}</p>}

          <section className="border-t border-border/50 pt-3">
            {given ? (
              <p className="text-sm text-emerald-300">{t('alert.thanks')}</p>
            ) : (
              <>
                <p className="mb-2 text-sm">{t('alert.relevant')}</p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => rate('relevant')}><ThumbsUp className="h-3.5 w-3.5" aria-hidden />{t('alert.yes').replace(/^\S+\s/, '')}</Button>
                  <Button variant="outline" size="sm" onClick={() => rate('not_relevant')}><ThumbsDown className="h-3.5 w-3.5" aria-hidden />{t('alert.no').replace(/^\S+\s/, '')}</Button>
                </div>
              </>
            )}
          </section>
        </DialogContent>
      )}
    </Dialog>
  );
}
