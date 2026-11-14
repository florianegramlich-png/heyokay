import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert as RNAlert, Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Button, s, Section, ToggleRow } from '../components/ui';
import { api } from '../lib/api';
import { geocode, locationAccess, stopBackgroundUpdates, type LocationAccess } from '../lib/location';
import { session } from '../lib/session';
import { colors } from '../lib/theme';
import { CATEGORIES, CATEGORY_HINT, CATEGORY_LABEL, type SavedPlace, type UserPrefs } from '../lib/types';

const LIMITS = [1, 3, 5, 10];

export default function Settings() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [access, setAccess] = useState<LocationAccess>('denied');
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [placeError, setPlaceError] = useState<string | null>(null);

  useEffect(() => {
    api.me().then((me) => { setPrefs(me.prefs); setPlaces(me.places); }).catch(() => null);
    locationAccess().then(setAccess);
  }, []);

  async function save(patch: Partial<UserPrefs>) {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next); // optimistic
    try { setPrefs((await api.updatePrefs(patch)).prefs); } catch { setPrefs(prefs); }
  }

  async function addPlace() {
    setPlaceError(null);
    const hit = await geocode(address).catch(() => null);
    if (!hit) { setPlaceError('Adresse nicht gefunden.'); return; }
    try {
      const { place } = await api.addPlace(label.trim() || address.trim(), hit.lat, hit.lon);
      setPlaces((p) => [...p, place]);
      setLabel(''); setAddress('');
    } catch {
      setPlaceError('Konnte den Ort nicht speichern (max. 10 Orte).');
    }
  }

  async function removePlace(id: string) {
    setPlaces((p) => p.filter((x) => x.id !== id));
    await api.deletePlace(id).catch(() => null);
  }

  function confirmDelete() {
    RNAlert.alert('Alle Daten löschen?', 'Dein Konto, Standort, Orte und Warnungen werden sofort und endgültig gelöscht.', [
      { text: 'Abbrechen', style: 'cancel' },
      {
        text: 'Löschen', style: 'destructive', onPress: async () => {
          await api.deleteAccount().catch(() => null);
          await stopBackgroundUpdates();
          await session.clear();
          router.replace('/onboarding');
        },
      },
    ]);
  }

  if (!prefs) return <Text style={[s.muted, { padding: 24 }]}>Lädt…</Text>;
  const quiet = prefs.quietHours;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Section title="Worüber informieren">
        {CATEGORIES.map((c, i) => (
          <ToggleRow
            key={c}
            label={CATEGORY_LABEL[c]}
            hint={CATEGORY_HINT[c]}
            value={prefs.categories.includes(c)}
            last={i === CATEGORIES.length - 1}
            onChange={(on) => save({ categories: on ? [...prefs.categories, c] : prefs.categories.filter((x) => x !== c) })}
          />
        ))}
      </Section>

      <Section title="Benachrichtigungen">
        <ToggleRow
          label="Nachtruhe 22–7 Uhr"
          hint="Nur amtliche Extremwarnungen kommen durch"
          value={!!quiet}
          onChange={(on) => save({ quietHours: on ? { start: '22:00', end: '07:00' } : null })}
        />
        <Text style={[s.rowLabel, { marginTop: 12 }]}>Höchstens pro Tag</Text>
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
        <Text style={[s.rowHint, { marginTop: 8 }]}>Hohe und extreme Warnungen zählen nicht zum Limit.</Text>
      </Section>

      <Section title="Standort">
        <Text style={s.p}>
          {access === 'always' ? 'Immer erlaubt – Warnungen auch unterwegs.'
            : access === 'foreground' ? 'Nur beim Öffnen. Unterwegs warnen wir nur für gespeicherte Orte.'
            : 'Nicht erlaubt. Wir warnen nur für gespeicherte Orte.'}
        </Text>
        {access !== 'always' ? <Button kind="secondary" title="In den Systemeinstellungen ändern" onPress={() => Linking.openSettings()} /> : null}
      </Section>

      <Section title="Gespeicherte Orte">
        {places.map((p) => (
          <View key={p.id} style={[s.row, s.rowLine]}>
            <Text style={[s.rowLabel, { flex: 1 }]}>{p.label}</Text>
            <Text style={{ color: colors.danger }} onPress={() => removePlace(p.id)}>Entfernen</Text>
          </View>
        ))}
        <TextInput placeholder="Name, z. B. Kita" value={label} onChangeText={setLabel} style={input} maxLength={40} />
        <TextInput placeholder="Adresse" value={address} onChangeText={setAddress} style={input} />
        {placeError ? <Text style={{ color: colors.danger, marginTop: 6 }}>{placeError}</Text> : null}
        <Button kind="secondary" title="Ort hinzufügen" disabled={!address.trim()} onPress={addPlace} />
      </Section>

      <Section title="Datenschutz">
        <Text style={s.p}>Wir speichern nur deinen letzten Standort, deine Orte und Einstellungen. Kein Verlauf.</Text>
        <Button kind="danger" title="Alle Daten löschen" onPress={confirmDelete} />
      </Section>
    </ScrollView>
  );
}

const input = {
  borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, marginTop: 10, fontSize: 16, color: colors.text,
} as const;
