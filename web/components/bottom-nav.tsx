'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clock, Radar } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function BottomNav() {
  const { t } = useI18n();
  const path = usePathname();
  if (path === '/onboarding') return null;
  const items = [
    { href: '/now', label: t('web.nav.now'), Icon: Radar },
    { href: '/history', label: t('web.nav.history'), Icon: Clock },
  ];
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40">
      <nav className="mx-auto max-w-md px-4 pb-4">
        <ul className="flex items-center rounded-2xl border border-border/50 bg-background/80 p-2 shadow-lg backdrop-blur-lg">
          {items.map(({ href, label, Icon }) => {
            const active = path === href;
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('flex flex-col items-center rounded-xl p-2 text-xs transition-colors', active ? 'bg-purple-500/10 text-purple-400' : 'text-muted-foreground hover:text-foreground')}
                >
                  <Icon className="mb-1 h-5 w-5" aria-hidden />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
