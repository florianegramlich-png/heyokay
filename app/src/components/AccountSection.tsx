import { useEffect, useState } from 'react';
import { Alert as RNAlert, Platform, Text, TextInput, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { api, ApiError } from '../lib/api';
import { useI18n, type Key } from '../lib/i18n';
import { session } from '../lib/session';
import { clearOffline } from '../lib/offline';
import { colors } from '../lib/theme';
import { buttonsToShow, makeNonce, NO_PROVIDERS, providerErrorKey, type Providers } from '../lib/signin';
import type { SavedPlace, UserPrefs } from '../lib/types';
import { Button, s, Section } from './ui';

/**
 * Sign-in with an email code or, on iPhone, with Apple (PRD 5.3): restore places and settings on a new phone.
 * The Apple button shows only when the server has Apple sign-in switched on and the phone supports it.
 * Google on the phone follows (roadmap "Sign-in: Apple + Google, part 2b").
 * Optional — the app works the same without it. The device keeps its token; the server attaches
 * it to the account (and merges the places this phone already had).
 */
export function AccountSection({ email: signedIn, onChanged }: {
  email: string | null;
  /** New state after sign-in or sign-out: the settings screen reloads prefs and places from it. */
  onChanged: (next: { email: string | null; prefs: UserPrefs; places: SavedPlace[] }) => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [providers, setProviders] = useState<Providers>(NO_PROVIDERS);
  const [appleHere, setAppleHere] = useState(false);

  useEffect(() => {
    if (signedIn) return;
    let live = true;
    api.authProviders().then((p) => { if (live) setProviders(p); }).catch(() => {});
    if (Platform.OS === 'ios') AppleAuthentication.isAvailableAsync().then((ok) => { if (live) setAppleHere(ok); }).catch(() => {});
    return () => { live = false; };
  }, [signedIn]);
  const buttons = buttonsToShow(providers, { apple: appleHere, google: false });

  async function signInWithApple() {
    setBusy(true); setError(null);
    try {
      const nonce = await makeNonce(Crypto.getRandomBytes, (s) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s));
      const cred = await AppleAuthentication.signInAsync({ requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL], nonce: nonce.hashed });
      if (!cred.identityToken) { setError('acc.err.provider'); return; }
      const r = await api.signInWith('apple', cred.identityToken, nonce.raw);
      onChanged({ email: r.account.email, prefs: r.prefs, places: r.places });
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return; // closed the sheet: nothing to say
      setError(e instanceof ApiError ? providerErrorKey(e.status, e.message) : 'acc.err.generic');
    } finally { setBusy(false); }
  }

  const fail = (err: unknown) => {
    const status = err instanceof ApiError ? err.status : 0;
    const msg = err instanceof ApiError ? err.message : '';
    setError(status === 503 ? 'acc.err.unavailable' : status === 429 ? 'acc.err.rate' : msg === 'invalid_code' ? 'acc.err.code' : status === 400 ? 'acc.err.invalidEmail' : 'acc.err.generic');
  };

  async function sendCode() {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('acc.err.invalidEmail'); return; }
    setBusy(true); setError(null);
    try { await api.emailStart(email.trim()); setStep('code'); } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setError(null);
    try {
      const r = await api.emailVerify(email.trim(), code.trim());
      setCode(''); setStep('email');
      onChanged({ email: r.account.email, prefs: r.prefs, places: r.places });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  function signOut() {
    RNAlert.alert(t('acc.signOut'), t('acc.signOut.confirm'), [
      { text: t('set.delete.cancel'), style: 'cancel' },
      {
        text: t('acc.signOut'), style: 'destructive', onPress: async () => {
          try {
            const r = await api.signOut();
            await session.setToken(r.token); // a fresh anonymous identity for this device
            await clearOffline(); // the saved alerts belonged to the account
            onChanged({ email: null, prefs: r.prefs, places: [] });
          } catch (e) { fail(e); }
        },
      },
    ]);
  }

  const input = { color: colors.text, borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, marginBottom: 8 } as const;

  return (
    <Section title={t('acc.title')}>
      {signedIn ? (
        <View>
          <Text style={[s.p, { color: colors.text, fontWeight: '600' }]}>{t('acc.signedIn', { email: signedIn })}</Text>
          <Text style={s.p}>{t('acc.signedInHint')}</Text>
          <Button kind="secondary" title={t('acc.signOut')} onPress={signOut} />
        </View>
      ) : step === 'email' ? (
        <View>
          <Text style={s.p}>{t('acc.intro')}</Text>
          {buttons.includes('apple') ? (
            <View style={{ marginBottom: 12 }}>
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                cornerRadius={10}
                style={{ width: '100%', height: 44, opacity: busy ? 0.5 : 1 }}
                onPress={() => { if (!busy) void signInWithApple(); }}
              />
              <Text style={[s.muted, { marginTop: 10 }]}>{t('acc.or')}</Text>
            </View>
          ) : null}
          <TextInput
            placeholder={t('acc.email')} placeholderTextColor={colors.muted} value={email} onChangeText={setEmail}
            autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress"
            style={input} keyboardAppearance="dark" accessibilityLabel={t('acc.email')}
          />
          <Button title={t('acc.send')} disabled={busy || !email.trim()} onPress={sendCode} />
        </View>
      ) : (
        <View>
          <Text style={s.p}>{t('acc.sent', { email: email.trim() })}</Text>
          <TextInput
            placeholder={t('acc.code')} placeholderTextColor={colors.muted} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6}
            style={[input, { letterSpacing: 6, fontSize: 20, textAlign: 'center' }]} keyboardAppearance="dark" accessibilityLabel={t('acc.code')}
          />
          <Button title={t('acc.verify')} disabled={busy || code.length !== 6} onPress={verify} />
          <Text style={[s.muted, { color: colors.cyan, marginTop: 10, textAlign: 'center' }]} onPress={() => { setStep('email'); setCode(''); setError(null); }}>{t('acc.back')}</Text>
        </View>
      )}
      {error ? <Text accessibilityRole="alert" style={{ color: colors.danger, marginTop: 8 }}>{t(error)}</Text> : null}
    </Section>
  );
}
