'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { AlertCard } from '@/components/alert-card';
import { AlertDialog } from '@/components/alert-dialog';
import { api } from '@/lib/api';
import { useDevice } from '@/lib/use-device';
import { useI18n } from '@/lib/i18n';
import type { Alert, Feedback } from '@/lib/types';

/** Everything the server keeps for this device (newest first), including updates, all-clears and ended events. */
export default function History() {
  const ready = useDevice();
  const { t } = useI18n();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Alert | null>(null);

  useEffect(() => {
    if (!ready) return;
    api.alerts().then((r) => setAlerts(r.alerts)).catch(() => setError(true));
  }, [ready]);

  const markFeedback = (id: string, f: Feedback) => setAlerts((as) => as?.map((a) => (a.id === id ? { ...a, feedback: f } : a)) ?? null);
  if (!ready) return null;

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">{t('web.history.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('web.history.subtitle')}</p>
      </div>
      {error && <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">{t('feed.error.text')}</CardContent></Card>}
      {alerts?.length === 0 && <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">{t('web.history.empty')}</CardContent></Card>}
      {alerts?.map((a) => <AlertCard key={a.id} alert={a} onOpen={setOpen} showCategory />)}
      <AlertDialog alert={open} onClose={() => setOpen(null)} onFeedback={markFeedback} />
    </div>
  );
}
