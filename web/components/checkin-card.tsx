'use client';

import { useState } from 'react';
import { HeartHandshake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { Checkin, CheckinAnswer } from '@/lib/family';

/**
 * "Hey, okay?" (PRD 6.1 #8): after a severe event where you are, one tap tells your family how you
 * are. On the Now page and in the alert's detail. Same card as the phone app
 * (app/src/components/CheckinCard.tsx); a browser has no notification buttons, so this is where
 * web users answer. Hey-Okay never calls anyone; after "Bitte meldet euch" it names the emergency number.
 */
export function CheckinCard({ checkin, onAnswered }: { checkin: Checkin; onAnswered?: (next: Checkin) => void }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(checkin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const answer = async (a: CheckinAnswer) => {
    setBusy(true); setError(false);
    try {
      const { checkin: next } = await api.answerCheckin(current.id, a);
      setCurrent(next);
      onAnswered?.(next);
    } catch {
      setError(true);
    } finally { setBusy(false); }
  };

  return (
    <Card className="border-cyan-400/40 bg-cyan-400/10"><CardContent className="space-y-3 p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold"><HeartHandshake className="h-5 w-5 text-cyan-400" aria-hidden />{t('fam.ci.title')}</h2>
      {current.title && <p className="text-sm">{t('fam.ci.body', { what: current.title })}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button variant={current.answer === 'ok' ? 'default' : 'outline'} disabled={busy} aria-pressed={current.answer === 'ok'} onClick={() => void answer('ok')}>{t('fam.ci.ok')}</Button>
        <Button variant={current.answer === 'call_me' ? 'default' : 'outline'} disabled={busy} aria-pressed={current.answer === 'call_me'} onClick={() => void answer('call_me')}>{t('fam.ci.callMe')}</Button>
      </div>
      {current.answer && <p role="status" className="text-sm">{t('fam.ci.told')}</p>}
      {current.answer === 'call_me' && (
        <a href={`tel:${current.emergency}`} className="block text-sm font-medium text-cyan-400 underline-offset-2 hover:underline">{t('fam.ci.emergency', { number: current.emergency })}</a>
      )}
      <p className="text-xs text-muted-foreground">{t('fam.ci.private')}</p>
      {error && <p role="alert" className="text-sm text-orange-300">{t('fam.ci.error')}</p>}
    </CardContent></Card>
  );
}
