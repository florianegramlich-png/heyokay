import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Galaxy } from '@/components/galaxy';
import { Header } from '@/components/header';
import { BottomNav } from '@/components/bottom-nav';
import { LangSync } from '@/components/lang-sync';

export const metadata: Metadata = {
  title: 'Hey-Okay',
  description: 'Ruhige Warnungen für deine Umgebung: nur was dich betrifft, und was du tun kannst.',
};

export const viewport: Viewport = { themeColor: '#0f172a', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className="dark">
      <body className="min-h-screen antialiased">
        <Galaxy />
        <LangSync />
        <div className="relative z-10">
          <Header />
          <main className="mx-auto max-w-md px-4 pb-28 pt-4">{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
