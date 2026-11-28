'use client';

import { useState } from 'react';
import { MapPin, Share2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useI18n, type Key } from '@/lib/i18n';
import {
  answerKey, answerTime, canInvite, canRemove, familyAnswers, FAMILY_NAME_MAX, familyErrorKey, formatCode, inviteDate, normalizeCode, othersPlaces, validName,
  type Family, type FamilyInvite, type FamilyMember,
} from '@/lib/family';

/**
 * Family sharing (PRD 6.1 #8): the same section as in the phone app
 * (app/src/components/FamilySection.tsx). Start a family or join one with a code, see who is in it
 * and the places the others share, invite (admin), take someone out (admin), leave. The share
 * switch for one's own places is under "Saved places".
 */
export function FamilySection({ family, onChanged }: {
  family: Family | null;
  /** New family state (null after leaving). `placesChanged`: one's own places stopped being shared. */
  onChanged: (next: Family | null, placesChanged?: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<FamilyInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) {
      setError(e instanceof ApiError ? familyErrorKey(e.status, e.message) : 'fam.err.generic');
    } finally { setBusy(false); }
  };

  const start = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!validName(name)) { setError('fam.err.name'); return; }
      onChanged((await api.startFamily(name.trim())).family, true);
      setName('');
    });
  };

  const join = () => run(async () => {
    if (!validName(name)) { setError('fam.err.name'); return; }
    const normalized = normalizeCode(code);
    if (!normalized) { setError('fam.err.code'); return; }
    onChanged((await api.joinFamily(normalized, name.trim())).family, true);
    setName(''); setCode('');
  });

  /** The browser's share sheet where there is one (Android, iPhone), else copy the text. */
  const shareInvite = async (inv: FamilyInvite) => {
    const text = t('fam.invite.share', { code: inv.code, date: inviteDate(inv, locale) });
    try {
      if (typeof navigator.share === 'function') { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch { /* closed the share sheet, or no clipboard: the code is on screen */ }
  };

  const remove = (m: FamilyMember) => {
    if (!window.confirm(t('fam.remove.confirm', { name: m.name }))) return;
    void run(async () => { onChanged((await api.removeFamilyMember(m.id)).family); });
  };

  const leave = () => {
    if (!window.confirm(t('fam.leave.confirm'))) return;
    void run(async () => { await api.leaveFamily(); setInvite(null); onChanged(null, true); });
  };

  const shared = family ? othersPlaces(family) : [];
  const answers = family ? familyAnswers(family) : [];
  return (
    <Card><CardContent className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Users className="h-4 w-4" aria-hidden />{t('fam.title')}
      </h2>
      {!family ? (
        <form onSubmit={start} className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('fam.intro')}</p>
          <Input placeholder={t('fam.yourName')} aria-label={t('fam.yourName')} maxLength={FAMILY_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" className="w-full" disabled={busy || !name.trim()}>{t('fam.start')}</Button>
          <Input
            placeholder={t('fam.code')} aria-label={t('fam.code')} autoCapitalize="characters" autoComplete="off" spellCheck={false}
            className="text-center tracking-[0.2em]" maxLength={9} value={code} onChange={(e) => setCode(formatCode(e.target.value))}
          />
          <Button type="button" variant="outline" className="w-full" disabled={busy || !name.trim() || !normalizeCode(code)} onClick={() => void join()}>{t('fam.join')}</Button>
        </form>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('fam.members', { n: family.members.length, max: family.max })}</p>
          <ul className="divide-y divide-border">
            {family.members.map((m) => (
              <li key={m.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="flex-1">
                  {m.name}{m.you ? ` (${t('fam.you')})` : ''}
                  {m.admin && <span className="text-xs text-muted-foreground"> · {t('fam.admin')}</span>}
                </span>
                {canRemove(family, m) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(m)}>{t('fam.remove')}</Button>}
              </li>
            ))}
          </ul>

          {answers.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">{t('fam.ci.family')}</h3>
              <ul className="space-y-1">
                {answers.map((a) => (
                  <li key={a.memberId} className="flex items-center gap-2 text-sm">
                    <span className={`flex-1 ${a.answer === 'call_me' ? 'font-medium text-cyan-400' : ''}`}>{a.name}: {t(answerKey(a.answer))}</span>
                    <span className="text-xs text-muted-foreground">{answerTime(a.answeredAt, locale)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {family.admin && (canInvite(family) ? (
            invite ? (
              <div className="space-y-2 rounded-lg border border-border p-3 text-center">
                <p className="select-all text-2xl font-bold tracking-[0.15em]">{invite.code}</p>
                <p className="text-xs text-muted-foreground">{t('fam.invite.valid', { date: inviteDate(invite, locale) })}</p>
                <Button className="w-full" onClick={() => void shareInvite(invite)}><Share2 className="h-4 w-4" aria-hidden />{t('fam.invite.shareButton')}</Button>
                {copied && <p role="status" className="text-xs text-muted-foreground">{t('fam.invite.copied')}</p>}
              </div>
            ) : (
              <Button variant="outline" className="w-full" disabled={busy} onClick={() => void run(async () => { setCopied(false); setInvite(await api.familyInvite()); })}>{t('fam.invite')}</Button>
            )
          ) : <p className="text-sm text-muted-foreground">{t('fam.full', { max: family.max })}</p>)}

          <div>
            <h3 className="mb-1 text-sm font-medium">{t('fam.places')}</h3>
            {shared.length ? (
              <ul className="space-y-1">
                {shared.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 text-sm">
                    <MapPin className="h-4 w-4 text-cyan-400" aria-hidden />
                    <span className="flex-1">{p.label}</span>
                    <span className="text-xs text-muted-foreground">{t('fam.places.by', { name: p.by })}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-muted-foreground">{t('fam.places.none')}</p>}
          </div>

          <Button variant="outline" className="w-full" disabled={busy} onClick={leave}>{t('fam.leave')}</Button>
        </>
      )}
      {error && <p role="alert" className="text-sm text-orange-300">{t(error)}</p>}
    </CardContent></Card>
  );
}
