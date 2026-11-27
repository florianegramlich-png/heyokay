import { useState } from 'react';
import { Alert as RNAlert, Share, Text, TextInput, View } from 'react-native';
import { api, ApiError } from '../lib/api';
import { useI18n, type Key } from '../lib/i18n';
import { colors } from '../lib/theme';
import {
  canInvite, canRemove, FAMILY_NAME_MAX, familyErrorKey, formatCode, inviteDate, normalizeCode, othersPlaces, validName,
  type Family, type FamilyInvite, type FamilyMember,
} from '../lib/family';
import { Button, s, Section } from './ui';

/**
 * Family sharing (PRD 6.1 #8): start a family or join one with a code, see who is in it and the
 * places the others share, invite (admin), take someone out (admin), leave. The share switch for
 * one's own places sits under "Saved places" in Settings. Same section as on the web
 * (web/components/family-section.tsx); the rules are on the server.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) {
      setError(e instanceof ApiError ? familyErrorKey(e.status, e.message) : 'fam.err.generic');
    } finally { setBusy(false); }
  };

  const start = () => run(async () => {
    if (!validName(name)) { setError('fam.err.name'); return; }
    onChanged((await api.startFamily(name.trim())).family, true);
    setName('');
  });

  const join = () => run(async () => {
    if (!validName(name)) { setError('fam.err.name'); return; }
    const normalized = normalizeCode(code);
    if (!normalized) { setError('fam.err.code'); return; }
    onChanged((await api.joinFamily(normalized, name.trim())).family, true);
    setName(''); setCode('');
  });

  const makeInvite = () => run(async () => { setInvite(await api.familyInvite()); });

  const shareInvite = (inv: FamilyInvite) => {
    void Share.share({ message: t('fam.invite.share', { code: inv.code, date: inviteDate(inv, locale) }) }).catch(() => null);
  };

  const remove = (m: FamilyMember) => {
    RNAlert.alert(t('fam.remove'), t('fam.remove.confirm', { name: m.name }), [
      { text: t('set.delete.cancel'), style: 'cancel' },
      { text: t('fam.remove'), style: 'destructive', onPress: () => void run(async () => { onChanged((await api.removeFamilyMember(m.id)).family); }) },
    ]);
  };

  const leave = () => {
    RNAlert.alert(t('fam.leave'), t('fam.leave.confirm'), [
      { text: t('set.delete.cancel'), style: 'cancel' },
      { text: t('fam.leave'), style: 'destructive', onPress: () => void run(async () => { await api.leaveFamily(); setInvite(null); onChanged(null, true); }) },
    ]);
  };

  const err = error ? <Text style={{ color: colors.danger, marginTop: 8 }} accessibilityLiveRegion="polite">{t(error)}</Text> : null;

  if (!family) {
    return (
      <Section title={t('fam.title')}>
        <Text style={s.p}>{t('fam.intro')}</Text>
        <TextInput
          placeholder={t('fam.yourName')} placeholderTextColor={colors.muted} value={name} onChangeText={setName}
          maxLength={FAMILY_NAME_MAX} style={input} keyboardAppearance="dark" accessibilityLabel={t('fam.yourName')}
        />
        <Button title={t('fam.start')} disabled={busy || !name.trim()} onPress={() => void start()} />
        <TextInput
          placeholder={t('fam.code')} placeholderTextColor={colors.muted} value={code} onChangeText={(v) => setCode(formatCode(v))}
          autoCapitalize="characters" autoCorrect={false} maxLength={9} style={[input, { marginTop: 18 }]} keyboardAppearance="dark"
          accessibilityLabel={t('fam.code')}
        />
        <Button kind="secondary" title={t('fam.join')} disabled={busy || !name.trim() || !normalizeCode(code)} onPress={() => void join()} />
        {err}
      </Section>
    );
  }

  const shared = othersPlaces(family);
  return (
    <Section title={t('fam.title')}>
      <Text style={[s.muted, { marginBottom: 4 }]}>{t('fam.members', { n: family.members.length, max: family.max })}</Text>
      {family.members.map((m) => (
        <View key={m.id} style={[s.row, s.rowLine]}>
          <Text style={[s.rowLabel, { flex: 1 }]}>
            {m.name}{m.you ? ` (${t('fam.you')})` : ''}
            {m.admin ? <Text style={s.muted}>{` · ${t('fam.admin')}`}</Text> : null}
          </Text>
          {canRemove(family, m) ? <Text style={{ color: colors.danger }} onPress={() => remove(m)} accessibilityRole="button">{t('fam.remove')}</Text> : null}
        </View>
      ))}

      {family.admin ? (
        canInvite(family) ? (
          invite ? (
            <View style={{ marginTop: 12 }}>
              <Text selectable style={{ color: colors.text, fontSize: 26, fontWeight: '700', letterSpacing: 2, textAlign: 'center' }}>{invite.code}</Text>
              <Text style={[s.muted, { textAlign: 'center', marginTop: 4 }]}>{t('fam.invite.valid', { date: inviteDate(invite, locale) })}</Text>
              <Button title={t('fam.invite.shareButton')} onPress={() => shareInvite(invite)} />
            </View>
          ) : <Button kind="secondary" title={t('fam.invite')} disabled={busy} onPress={() => void makeInvite()} />
        ) : <Text style={[s.muted, { marginTop: 10 }]}>{t('fam.full', { max: family.max })}</Text>
      ) : null}

      <Text style={[s.rowLabel, { marginTop: 18, fontWeight: '600' }]}>{t('fam.places')}</Text>
      {shared.length ? shared.map((p) => (
        <View key={p.id} style={[s.row, s.rowLine]}>
          <Text style={[s.rowLabel, { flex: 1 }]}>{p.label}</Text>
          <Text style={s.muted}>{t('fam.places.by', { name: p.by })}</Text>
        </View>
      )) : <Text style={[s.muted, { marginTop: 4 }]}>{t('fam.places.none')}</Text>}

      <Button kind="danger" title={t('fam.leave')} disabled={busy} onPress={leave} />
      {err}
    </Section>
  );
}

const input = {
  borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, marginTop: 10, fontSize: 16, color: colors.text,
  backgroundColor: 'rgba(255,255,255,0.05)',
} as const;
