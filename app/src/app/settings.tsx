import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert as RNAlert, Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Button, s, Section, ToggleRow } from '../components/ui';
import { api } from '../lib/api';
import { crashReportingAvailable, getCrashReportsOptIn, setCrashReportsOptIn } from '../lib/crash';
import { setLanguage, useI18n, type Lang } from '../lib/i18n';
import { geocode, locationAccess, stopBackgroundUpdates, type LocationAccess } from '../lib/location';
import { session } from '../lib/session';
import { colors } from '../lib/theme';
import { CATEGORIES, type SavedPlace, type UserPrefs } from '../lib/types';

const LIMITS = [1, 3, 5, 10];

export default function Settings() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [access, setAccess] = useState<LocationAccess>('denied');
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [crashReports, setCrashReports] = useState(false);
  const showCrashToggle = crashReportingAvailable();
  const { t, lang, categoryLabel, categoryHint } = useI18n();

  useEffect(() => {
    api.me().then((me) => { setPrefs(me.prefs); setPlaces(me.places); }).catch(() => null);
    locationAccess().then(setAccess);
    getCrashReportsOptIn().then(setCrashReports);
  }, []);

  async function toggleCrashReports(v: boolean) {
    setCrashReports(v);
    await setCrashReportsOptIn(v);
  }

  async function save(patch: Partial<UserPrefs>) {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next); // optimistic
    try { setPrefs((await api.updatePrefs(patch)).prefs); } catch { setPrefs(prefs); }
  }

  function changeLanguage(l: Lang) {
    void setLanguage(l);
    void save({ language: l });
  }

  async function addPlace() {
    setPlaceError(null);
    const hit = await geocode(address).catch(() => null);
    if (!hit) { setPlaceError(t('set.places.notFound')); return; }
    try {
      const { place } = await api.addPlace(label.trim() || address.trim(), hit.lat, hit.lon);
      setPlaces((p) => [...p, place]);
      setLabel(''); setAddress('');
    } catch {
      setPlaceError(t('set.places.saveFailed'));
    }
  }

  async function removePlace(id: string) {
    setPlaces((p) => p.filter((x) => x.id !== id));
    await api.deletePlace(id).catch(() => null);
  }

  function confirmDelete() {
    RNAlert.alert(t('set.delete.title'), t('set.delete.text'), [
      { text: t('set.delete.cancel'), style: 'cancel' },
      {
        text: t('set.delete.confirm'), style: 'destructive', onPress: async () => {
          await api.deleteAccount().catch(() => null);
          await stopBackgroundUpdates();
          await setCrashReportsOptIn(false);
          await session.clear();
          router.replace('/onboarding');
        },
      },
    ]);
  }

  if (!prefs) return <Text style={[s.muted, { padding: 24 }]}>{t('set.loading')}</Text>;
  const quiet = prefs.quietHours;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Section title={t('set.language')}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['de', 'en'] as Lang[]).map((l) => (
            <Pressable
              key={l}
              onPress={() => changeLanguage(l)}
              accessibilityRole="button"
              accessibilityState={{ selected: lang === l }}
              style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: lang === l ? colors.brand : colors.brandSoft }}
            >
              <Text style={{ color: lang === l ? '#fff' : colors.brand, fontWeight: '600' }}>{l === 'de' ? 'Deutsch' : 'English'}</Text>
            </Pressable>
          ))}
        </View>
      </Section>

      <Section title={t('set.topics')}>
        {CATEGORIES.map((c, i) => (
          <ToggleRow
            key={c}
            label={categoryLabel(c)}
            hint={categoryHint(c)}
            value={prefs.categories.includes(c)}
            last={i === CATEGORIES.length - 1}
            onChange={(on) => save({ categories: on ? [...prefs.categories, c] : prefs.categories.filter((x) => x !== c) })}
          />
        ))}
      </Section>

      <Section title={t('set.notifications')}>
        <ToggleRow
          label={t('set.quiet')}
          hint={t('set.quiet.hint')}
          value={!!quiet}
          onChange={(on) => save({ quietHours: on ? { start: '22:00', end: '07:00' } : null })}
        />
        <Text style={[s.rowLabel, { marginTop: 12 }]}>{t('set.limit')}</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          {LIMITS.map((n) => (
            <Pressable
              key={n}
              onPress={() => save({ dailyLimit: n })}
              style={{
                flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                backgroundColor: prefs.dailyLimit === n ? colors.brand : colors.brandSoft,
              }}
            >
              <Text style={{ color: prefs.dailyLimit === n ? '#fff' : colors.brand, fontWeight: '600' }}>{n}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[s.rowHint, { marginTop: 8 }]}>{t('set.limit.hint')}</Text>
      </Section>

      <Section title={t('set.location')}>
        <Text style={s.p}>
          {access === 'always' ? t('set.location.always')
            : access === 'foreground' ? t('set.location.foreground')
            : t('set.location.denied')}
        </Text>
        {access !== 'always' ? <Button kind="secondary" title={t('set.location.change')} onPress={() => Linking.openSettings()} /> : null}
      </Section>

      <Section title={t('set.places')}>
        {places.map((p) => (
          <View key={p.id} style={[s.row, s.rowLine]}>
            <Text style={[s.rowLabel, { flex: 1 }]}>{p.label}</Text>
            <Text style={{ color: colors.danger }} onPress={() => removePlace(p.id)}>{t('set.places.remove')}</Text>
          </View>
        ))}
        <TextInput placeholder={t('set.places.name')} value={label} onChangeText={setLabel} style={input} maxLength={40} />
        <TextInput placeholder={t('set.places.address')} value={address} onChangeText={setAddress} style={input} />
        {placeError ? <Text style={{ color: colors.danger, marginTop: 6 }}>{placeError}</Text> : null}
        <Button kind="secondary" title={t('set.places.add')} disabled={!address.trim()} onPress={addPlace} />
      </Section>

      <Section title={t('set.privacy')}>
        <Text style={s.p}>{t('set.privacy.text')}</Text>
        {showCrashToggle ? (
          <ToggleRow
            label={t('set.crash')}
            hint={t('set.crash.hint')}
            value={crashReports}
            onChange={toggleCrashReports}
            last
          />
        ) : null}
        <Button kind="danger" title={t('set.delete')} onPress={confirmDelete} />
      </Section>
    </ScrollView>
  );
}

const input = {
  borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, marginTop: 10, fontSize: 16, color: colors.text,
} as const;
