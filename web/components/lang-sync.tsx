'use client';

import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n';

/** Keeps <html lang> in step with the chosen language (screen readers, hyphenation). */
export function LangSync() {
  const { lang } = useI18n();
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  return null;
}
