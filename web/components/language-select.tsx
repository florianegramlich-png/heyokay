'use client';

import { Languages } from 'lucide-react';
import { LANGUAGES, setLanguage, useI18n, type Key } from '@/lib/i18n';
import type { Lang } from '@/lib/app-strings';
import { api } from '@/lib/api';
import { session } from '@/lib/session';

/** Pick a language. Saved on this device and, once registered, on the server (emails, alert texts). */
export function chooseLanguage(l: Lang) {
  setLanguage(l);
  if (session.getToken()) api.updatePrefs({ language: l }).catch(() => {});
}

/**
 * Language dropdown (a native <select>: keyboard, screen readers and phones handle it well).
 * `compact` = icon + name for the header; otherwise full width for settings and onboarding.
 */
export function LanguageSelect({ compact = false, onChange }: { compact?: boolean; onChange?: (l: Lang) => void }) {
  const { t, lang } = useI18n();
  return (
    <label className={compact ? 'flex items-center gap-1 text-xs text-muted-foreground' : 'flex items-center gap-2 text-sm'}>
      <Languages className="h-4 w-4 shrink-0" aria-hidden />
      <span className="sr-only">{t('set.language' as Key)}</span>
      <select
        value={lang}
        onChange={(e) => { const l = e.target.value as Lang; (onChange ?? chooseLanguage)(l); }}
        className={
          compact
            ? 'cursor-pointer rounded-md border-0 bg-transparent py-1 pr-1 text-xs text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring'
            : 'w-full cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring'
        }
      >
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
      </select>
    </label>
  );
}
