import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, RefreshControl, ScrollView, Text, View } from 'react-native';
import { AlertCard } from '../components/AlertCard';
import { SkyScreen } from '../components/Starfield';
import { Card, s } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { byCategory, earlierAlerts } from '../lib/feed';
import { useI18n } from '../lib/i18n';
import { locationAccess, syncNow } from '../lib/location';
import { session } from '../lib/session';
import { categoryColor, colors } from '../lib/theme';
import type { Alert } from '../lib/types';

/**
 * Main screen: what affects you and your places right now, grouped by topic (no scores),
 * "Alles okay." when nothing does, then what happened earlier.
 */
export default function Feed() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [noLocation, setNoLocation] = useState(false);
  const { t, categoryLabel } = useI18n();

  const load = useCallback(async (withLocation: boolean) => {
    setError(false);
    try {
      setNoLocation((await locationAccess()) === 'denied');
      if (withLocation) await syncNow().catch(() => null);
      const { alerts } = await api.alerts();
      setAlerts(alerts.filter((a) => a.delivery !== 'suppressed'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await session.clear(); // account was deleted or token lost → start over
        router.replace('/onboarding');
        return;
      }
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useFocusEffect(useCallback(() => { load(true); }, [load]));

  const open = (a: Alert) => router.push({ pathname: '/alert/[id]', params: { id: a.id } });
  const groups = byCategory(alerts);
  const earlier = earlierAlerts(alerts);

  return (
    <SkyScreen>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { setLoading(true); load(true); }} tintColor={colors.cyan} />}
      >
        <Text style={[s.h1, { fontSize: 26 }]}>{t('feed.now')}</Text>
        <Text style={[s.muted, { marginTop: 2, marginBottom: 14 }]}>{t('feed.now.subtitle')}</Text>

        {noLocation ? (
          <Card style={{ marginBottom: 12, backgroundColor: colors.cyanSoft, borderColor: 'rgba(34,211,238,0.3)' }}>
            <Text style={s.p}>{t('feed.noLocation')}</Text>
            <Text style={{ color: colors.cyan, fontWeight: '600', marginTop: 6 }} onPress={() => Linking.openSettings()}>
              {t('feed.noLocation.cta')}
            </Text>
          </Card>
        ) : null}

        {!loading && groups.length === 0 ? (
          <Card style={{ alignItems: 'center', paddingVertical: 32, marginBottom: 8 }}>
            <Text style={{ fontSize: 28, fontWeight: '700', color: error ? colors.text : colors.cyan }}>
              {error ? t('feed.error.title') : t('feed.empty.title')}
            </Text>
            <Text style={[s.muted, { textAlign: 'center', marginTop: 8, paddingHorizontal: 12 }]}>
              {error ? t('feed.error.text') : t('feed.empty.text')}
            </Text>
          </Card>
        ) : null}

        {groups.map((g) => (
          <View key={g.category} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: categoryColor[g.category] }} />
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>{categoryLabel(g.category)}</Text>
              <Text style={[s.muted, { fontSize: 13 }]}>· {t('feed.count', { n: g.alerts.length })}</Text>
            </View>
            {g.alerts.map((a) => <AlertCard key={a.id} alert={a} onPress={() => open(a)} />)}
          </View>
        ))}

        {earlier.length ? (
          <View style={{ marginTop: 16 }}>
            <Text style={s.sectionTitle}>{t('feed.earlier')}</Text>
            {earlier.map((a) => <AlertCard key={a.id} alert={a} onPress={() => open(a)} showCategory />)}
          </View>
        ) : null}
      </ScrollView>
    </SkyScreen>
  );
}
