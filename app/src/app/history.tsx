import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { AlertCard } from '../components/AlertCard';
import { SkyScreen } from '../components/Starfield';
import { Card, s } from '../components/ui';
import { api } from '../lib/api';
import { groupByDay } from '../lib/history';
import { useI18n } from '../lib/i18n';
import { categoryColor, colors } from '../lib/theme';
import { CATEGORIES, type Alert, type Category } from '../lib/types';

/**
 * Searchable history (PRD 5.3): everything that reached you, one entry per incident in its latest
 * state, by day. Search by words ("S-Bahn", a street, a saved place) and narrow by topic.
 */
export default function History() {
  const router = useRouter();
  const { t, categoryLabel, locale } = useI18n();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    // Wait for a pause in typing; only the latest answer counts.
    const timer = setTimeout(async () => {
      try {
        const res = await api.history({ q: q.trim() || undefined, category: category ?? undefined });
        if (mine === seq.current) { setAlerts(res.alerts); setError(false); }
      } catch {
        if (mine === seq.current) setError(true);
      }
    }, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [q, category]);

  const open = (a: Alert) => router.push({ pathname: '/alert/[id]', params: { id: a.id } });
  const groups = alerts ? groupByDay(alerts) : [];
  const dayLabel = (g: (typeof groups)[number]) =>
    g.label === 'today' ? t('history.today') : g.label === 'yesterday' ? t('history.yesterday')
      : g.date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const chip = (key: string, label: string, active: boolean, onPress: () => void, color?: string) => (
    <Pressable
      key={key}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1,
        borderColor: active ? (color ?? colors.brand) : colors.line,
        backgroundColor: active ? `${color ?? colors.brand}33` : 'rgba(255,255,255,0.04)',
      }}
    >
      <Text style={{ color: active ? colors.text : colors.muted, fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );

  return (
    <SkyScreen>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={t('history.search')}
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoCorrect={false}
          keyboardAppearance="dark"
          accessibilityLabel={t('history.search')}
          style={{
            backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.line, borderRadius: 12,
            paddingHorizontal: 14, paddingVertical: 12, color: colors.text, fontSize: 16,
          }}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10, marginBottom: 14 }} contentContainerStyle={{ gap: 8 }}>
          {chip('all', t('history.all'), category === null, () => setCategory(null))}
          {CATEGORIES.map((c) => chip(c, categoryLabel(c), category === c, () => setCategory(category === c ? null : c), categoryColor[c]))}
        </ScrollView>

        {error ? (
          <Card style={{ alignItems: 'center', paddingVertical: 24 }}>
            <Text style={[s.muted, { textAlign: 'center' }]}>{t('history.offline')}</Text>
          </Card>
        ) : alerts === null ? (
          <ActivityIndicator color={colors.cyan} style={{ marginTop: 24 }} />
        ) : alerts.length === 0 ? (
          <Card style={{ alignItems: 'center', paddingVertical: 24 }}>
            <Text style={[s.muted, { textAlign: 'center' }]}>{q || category ? t('history.none') : t('history.empty')}</Text>
          </Card>
        ) : (
          groups.map((g) => (
            <View key={g.key} style={{ marginBottom: 8 }}>
              <Text style={s.sectionTitle}>{dayLabel(g)}</Text>
              {g.alerts.map((a) => <AlertCard key={a.id} alert={a} onPress={() => open(a)} showCategory />)}
            </View>
          ))
        )}
      </ScrollView>
    </SkyScreen>
  );
}
