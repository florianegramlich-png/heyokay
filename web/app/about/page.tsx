'use client';

import { Card, CardContent } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n';

export default function About() {
  const { t } = useI18n();
  return (
    <Card><CardContent className="space-y-3 p-6">
      <h1 className="bg-gradient-to-r from-cyan-400 to-purple-500 bg-clip-text text-xl font-semibold text-transparent">{t('web.about.title')}</h1>
      <p className="text-sm text-foreground/90">{t('web.about.text')}</p>
      <p className="text-sm text-muted-foreground">{t('web.about.privacy')}</p>
    </CardContent></Card>
  );
}
