import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Card, s, ToggleRow } from '../components/ui';
import { api } from '../lib/api';
import { requestBackground, requestForeground, startBackgroundUpdates, syncNow } from '../lib/location';
import { getPushToken, requestPermission } from '../lib/notifications';
import { session } from '../lib/session';
import { colors } from '../lib/theme';
import { CATEGORIES, CATEGORY_HINT, CATEGORY_LABEL, DEFAULT_PREFS, type Category } from '../lib/types';

type Step = 'value' | 'location' | 'always' | 'notifications' | 'categories' | 'consent';

/** PRD 5.3 onboarding: value → location (foreground, then always) → notifications → categories → consent. */
export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('value');
  const [categories, setCategories] = useState<Category[]>(DEFAULT_PREFS.categories);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (c: Category, on: boolean) =>
    setCategories((cur) => (on ? [...new Set([...cur, c])] : cur.filter((x) => x !== c)));

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_PREFS.timezone;
      const pushToken = await getPushToken();
      const { token } = await api.register({ ...DEFAULT_PREFS, categories, timezone }, pushToken);
      await session.setToken(token);
      await session.setOnboarded();
      await startBackgroundUpdates();
      await syncNow(true).catch(() => null); // backfill: current alerts go to the feed, no push burst
      router.replace('/feed');
    } catch (e) {
      setError('Verbindung zum Server fehlgeschlagen. Bitte später erneut versuchen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, flexGrow: 1, justifyContent: 'center' }}>
        {step === 'value' && (
          <Screen
            title="Weniger Alarm. Mehr Bescheid wissen."
            text="Hey-Okay sagt dir in einem Satz, was in deiner Nähe los ist – Unwetter, Polizeilagen, Sperrungen – und was du tun kannst. Nur wenn es dich betrifft."
          >
            <Button title="Los geht’s" onPress={() => setStep('location')} />
          </Screen>
        )}

        {step === 'location' && (
          <Screen
            title="Wo bist du?"
            text="Wir brauchen deinen Standort, um nur Lagen in deiner Nähe zu melden. Wir speichern ausschließlich deinen letzten Standort – keinen Bewegungsverlauf."
          >
            <Button
              title="Standort erlauben"
              onPress={async () => setStep((await requestForeground()) ? 'always' : 'notifications')}
            />
            <Button kind="secondary" title="Später" onPress={() => setStep('notifications')} />
          </Screen>
        )}

        {step === 'always' && (
          <Screen
            title="Auch wenn die App zu ist?"
            text="Mit „Immer erlauben“ warnen wir dich auch unterwegs, ohne dass du die App öffnest. Ohne bekommst du Warnungen nur für deine gespeicherten Orte."
          >
            <Button title="Immer erlauben" onPress={async () => { await requestBackground(); setStep('notifications'); }} />
            <Button kind="secondary" title="Nur beim Öffnen" onPress={() => setStep('notifications')} />
          </Screen>
        )}

        {step === 'notifications' && (
          <Screen
            title="Benachrichtigungen"
            text="Höchstens 3 pro Tag, nachts still – außer bei amtlichen Extremwarnungen. Du kannst das jederzeit ändern."
          >
            <Button title="Benachrichtigungen erlauben" onPress={async () => { await requestPermission(); setStep('categories'); }} />
            <Button kind="secondary" title="Nur im Feed anzeigen" onPress={() => setStep('categories')} />
          </Screen>
        )}

        {step === 'categories' && (
          <Screen title="Was ist dir wichtig?" text="Wähle, worüber du informiert werden willst.">
            <Card style={{ marginBottom: 8 }}>
              {CATEGORIES.map((c, i) => (
                <ToggleRow
                  key={c}
                  label={CATEGORY_LABEL[c]}
                  hint={CATEGORY_HINT[c]}
                  value={categories.includes(c)}
                  onChange={(on) => toggle(c, on)}
                  last={i === CATEGORIES.length - 1}
                />
              ))}
            </Card>
            <Text style={s.muted}>Amtliche Extremwarnungen bekommst du immer.</Text>
            <Button title="Weiter" disabled={categories.length === 0} onPress={() => setStep('consent')} />
          </Screen>
        )}

        {step === 'consent' && (
          <Screen
            title="Deine Daten"
            text={
              'Wir verarbeiten deinen letzten Standort und deine Einstellungen, nur um dich zu warnen. ' +
              'Kein Verlauf, kein Konto, keine Werbung. Die KI sieht nie deine Daten – nur öffentliche Meldungen. ' +
              'Du kannst alles jederzeit in den Einstellungen löschen.'
            }
          >
            <Text style={[s.muted, { color: colors.brand, marginBottom: 8 }]} onPress={() => Linking.openURL('https://heyokay.de/datenschutz')}>
              Datenschutzerklärung lesen
            </Text>
            {error ? <Text style={{ color: colors.danger, marginBottom: 8 }}>{error}</Text> : null}
            <Button title={busy ? 'Einen Moment…' : 'Zustimmen und starten'} disabled={busy} onPress={finish} />
          </Screen>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Screen({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <View>
      <Text style={[s.h1, { marginBottom: 12 }]}>{title}</Text>
      <Text style={[s.p, { marginBottom: 24, color: colors.muted }]}>{text}</Text>
      {children}
    </View>
  );
}
