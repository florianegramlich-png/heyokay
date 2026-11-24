import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Starfield } from '../components/Starfield';
import { Button, Card, s, ToggleRow } from '../components/ui';
import { LanguagePicker } from '../components/LanguagePicker';
import { api } from '../lib/api';
import { setLanguage, useI18n } from '../lib/i18n';
import { requestBackground, requestForeground, startBackgroundUpdates, syncNow } from '../lib/location';
import { getPushToken, requestPermission } from '../lib/notifications';
import { session } from '../lib/session';
import { analytics } from '../lib/track';
import { colors } from '../lib/theme';
import { CATEGORIES, DEFAULT_PREFS, type Category } from '../lib/types';

type Step = 'value' | 'location' | 'always' | 'notifications' | 'categories' | 'consent';

/** PRD 5.3 onboarding: value → location (foreground, then always) → notifications → categories → consent. */
export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('value');
  const [categories, setCategories] = useState<Category[]>(DEFAULT_PREFS.categories);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [insights, setInsights] = useState(false); // optional, off unless chosen
  const { t, lang, categoryLabel, categoryHint } = useI18n();

  // Anonymous counts per screen (PRD 13 funnel): which step was shown, never who.
  useEffect(() => { analytics.track(`onb_${step}`); }, [step]);

  const toggle = (c: Category, on: boolean) =>
    setCategories((cur) => (on ? [...new Set([...cur, c])] : cur.filter((x) => x !== c)));

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_PREFS.timezone;
      const pushToken = await getPushToken();
      const { token } = await api.register({ ...DEFAULT_PREFS, categories, timezone, language: lang, insightsConsent: insights }, pushToken);
      await session.setToken(token);
      await session.setOnboarded();
      await startBackgroundUpdates();
      await syncNow(true).catch(() => null); // backfill: current alerts go to the feed, no push burst
      analytics.track('onb_done');
      void analytics.flush();
      router.replace('/feed');
    } catch (e) {
      setError(t('onb.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <Starfield />
      <ScrollView contentContainerStyle={{ padding: 24, flexGrow: 1, justifyContent: 'center' }}>
        {step === 'value' && (
          <Screen title={t('onb.value.title')} text={t('onb.value.text')}>
            <Button title={t('onb.value.cta')} onPress={() => setStep('location')} />
            <LanguagePicker compact value={lang} onChange={(l) => { void setLanguage(l); }} />
          </Screen>
        )}

        {step === 'location' && (
          <Screen title={t('onb.location.title')} text={t('onb.location.text')}>
            <Button
              title={t('onb.location.cta')}
              onPress={async () => {
                const ok = await requestForeground();
                analytics.permission('location', ok);
                setStep(ok ? 'always' : 'notifications');
              }}
            />
            <Button kind="secondary" title={t('onb.later')} onPress={() => { analytics.permission('location', 'later'); setStep('notifications'); }} />
          </Screen>
        )}

        {step === 'always' && (
          <Screen title={t('onb.always.title')} text={t('onb.always.text')}>
            <Button title={t('onb.always.cta')} onPress={async () => { analytics.permission('background', await requestBackground()); setStep('notifications'); }} />
            <Button kind="secondary" title={t('onb.always.skip')} onPress={() => { analytics.permission('background', 'later'); setStep('notifications'); }} />
          </Screen>
        )}

        {step === 'notifications' && (
          <Screen title={t('onb.notif.title')} text={t('onb.notif.text')}>
            <Button title={t('onb.notif.cta')} onPress={async () => { analytics.permission('push', await requestPermission()); setStep('categories'); }} />
            <Button kind="secondary" title={t('onb.notif.skip')} onPress={() => { analytics.permission('push', 'later'); setStep('categories'); }} />
          </Screen>
        )}

        {step === 'categories' && (
          <Screen title={t('onb.cat.title')} text={t('onb.cat.text')}>
            <Card style={{ marginBottom: 8 }}>
              {CATEGORIES.map((c, i) => (
                <ToggleRow
                  key={c}
                  label={categoryLabel(c)}
                  hint={categoryHint(c)}
                  value={categories.includes(c)}
                  onChange={(on) => toggle(c, on)}
                  last={i === CATEGORIES.length - 1}
                />
              ))}
            </Card>
            <Text style={s.muted}>{t('onb.cat.always')}</Text>
            <Button title={t('onb.next')} disabled={categories.length === 0} onPress={() => setStep('consent')} />
          </Screen>
        )}

        {step === 'consent' && (
          <Screen title={t('onb.consent.title')} text={t('onb.consent.text')}>
            <Text style={[s.muted, { color: colors.cyan, marginBottom: 8 }]} onPress={() => Linking.openURL('https://heyokay.de/datenschutz')}>
              {t('onb.consent.policy')}
            </Text>
            <Card style={{ marginBottom: 12 }}>
              <ToggleRow label={t('consent.insights.label')} hint={t('consent.insights.hint')} value={insights} onChange={setInsights} last />
            </Card>
            {error ? <Text style={{ color: colors.danger, marginBottom: 8 }}>{error}</Text> : null}
            <Button title={busy ? t('onb.consent.busy') : t('onb.consent.cta')} disabled={busy} onPress={finish} />
          </Screen>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Screen({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <View>
      <Text style={{ fontSize: 15, fontWeight: '700', marginBottom: 16 }}>
        <Text style={{ color: colors.cyan }}>Hey-</Text>
        <Text style={{ color: colors.brand }}>Okay</Text>
      </Text>
      <Text style={[s.h1, { marginBottom: 12 }]}>{title}</Text>
      <Text style={[s.p, { marginBottom: 24, color: colors.muted }]}>{text}</Text>
      {children}
    </View>
  );
}

