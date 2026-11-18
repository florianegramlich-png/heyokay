'use client';

import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useI18n, type Key } from '@/lib/i18n';
import { session } from '@/lib/session';
import type { SavedPlace, UserPrefs } from '@/lib/types';

/**
 * Sign-in with an email code: the same account as on the phone, so places and settings are here
 * too. Optional — the web app works without it.
 */
export function AccountSection({ email: signedIn, onChanged }: {
  email: string | null;
  onChanged: (next: { email: string | null; prefs: UserPrefs; places: SavedPlace[] }) => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);

  const fail = (err: unknown) => {
    const status = err instanceof ApiError ? err.status : 0;
    const msg = err instanceof ApiError ? err.message : '';
    setError(status === 503 ? 'acc.err.unavailable' : status === 429 ? 'acc.err.rate' : msg === 'invalid_code' ? 'acc.err.code' : status === 400 ? 'acc.err.invalidEmail' : 'acc.err.generic');
  };

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('acc.err.invalidEmail'); return; }
    setBusy(true); setError(null);
    try { await api.emailStart(email.trim()); setStep('code'); } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.emailVerify(email.trim(), code.trim());
      setCode(''); setStep('email');
      onChanged({ email: r.account.email, prefs: r.prefs, places: r.places });
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const signOut = async () => {
    if (!window.confirm(t('acc.signOut.confirm'))) return;
    try {
      const r = await api.signOut();
      session.setToken(r.token); // a fresh anonymous identity for this browser
      onChanged({ email: null, prefs: r.prefs, places: [] });
    } catch (err) { fail(err); }
  };

  return (
    <Card><CardContent className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <UserRound className="h-4 w-4" aria-hidden />{t('acc.title')}
      </h2>
      {signedIn ? (
        <>
          <p className="font-medium">{t('acc.signedIn', { email: signedIn })}</p>
          <p className="text-sm text-muted-foreground">{t('acc.signedInHint')}</p>
          <Button variant="outline" className="w-full" onClick={signOut}>{t('acc.signOut')}</Button>
        </>
      ) : step === 'email' ? (
        <form onSubmit={sendCode} className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('acc.intro')}</p>
          <Input type="email" autoComplete="email" placeholder={t('acc.email')} aria-label={t('acc.email')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" className="w-full" disabled={busy || !email.trim()}>{t('acc.send')}</Button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('acc.sent', { email: email.trim() })}</p>
          <Input
            inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder={t('acc.code')} aria-label={t('acc.code')}
            className="text-center text-xl tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>{t('acc.verify')}</Button>
          <button type="button" className="w-full text-sm text-cyan-400 hover:underline" onClick={() => { setStep('email'); setCode(''); setError(null); }}>{t('acc.back')}</button>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-orange-300">{t(error)}</p>}
    </CardContent></Card>
  );
}
