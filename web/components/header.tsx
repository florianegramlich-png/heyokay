'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Info, Menu, Settings, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { LanguageSelect } from '@/components/language-select';

export function Header() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/40 bg-background/70 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-md items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <button aria-label={t('web.menu')} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="rounded-md p-1 hover:bg-accent">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <Link href="/now" className="bg-gradient-to-r from-cyan-400 to-purple-500 bg-clip-text font-semibold text-transparent">
            Hey-Okay
          </Link>
        </div>
        <LanguageSelect compact />
      </div>
      {open && (
        <nav className="mx-auto max-w-md px-4 pb-3" onClick={() => setOpen(false)}>
          <ul className="space-y-1 rounded-xl border border-border/50 bg-background/90 p-2">
            <li><Link href="/settings" className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-accent"><Settings className="h-4 w-4" />{t('web.nav.settings')}</Link></li>
            <li><Link href="/about" className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-accent"><Info className="h-4 w-4" />{t('web.nav.about')}</Link></li>
          </ul>
        </nav>
      )}
    </header>
  );
}
