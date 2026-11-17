import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Linking, RefreshControl, Text, View } from 'react-native';
import { AlertCard } from '../components/AlertCard';
import { s } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { locationAccess, syncNow } from '../lib/location';
import { session } from '../lib/session';
import { colors } from '../lib/theme';
import type { Alert } from '../lib/types';

export default function Feed() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [noLocation, setNoLocation] = useState(false);
  const { t } = useI18n();

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

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={alerts}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ padding: 16, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { setLoading(true); load(true); }} tintColor={colors.brand} />}
        ListHeaderComponent={
          <View style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={s.muted}>{t('feed.header')}</Text>
              <Link href="/settings" style={{ color: colors.brand, fontSize: 15, fontWeight: '600' }}>{t('nav.settings')}</Link>
            </View>
            {noLocation ? (
              <View style={{ marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: colors.brandSoft }}>
                <Text style={s.p}>{t('feed.noLocation')}</Text>
                <Text style={{ color: colors.brand, fontWeight: '600', marginTop: 4 }} onPress={() => Linking.openSettings()}>
                  {t('feed.noLocation.cta')}
                </Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading ? undefined : (
            <View style={{ alignItems: 'center', marginTop: 80, paddingHorizontal: 24 }}>
              <Text style={{ fontSize: 40 }}>👌</Text>
              <Text style={[s.h1, { fontSize: 22, marginTop: 12, textAlign: 'center' }]}>
                {error ? t('feed.error.title') : t('feed.empty.title')}
              </Text>
              <Text style={[s.muted, { textAlign: 'center', marginTop: 6 }]}>
                {error ? t('feed.error.text') : t('feed.empty.text')}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <AlertCard alert={item} onPress={() => router.push({ pathname: '/alert/[id]', params: { id: item.id } })} />
        )}
      />
    </View>
  );
}
