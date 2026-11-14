import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { AlertCard } from '../components/AlertCard';
import { s } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { syncNow } from '../lib/location';
import { session } from '../lib/session';
import { colors } from '../lib/theme';
import type { Alert } from '../lib/types';

export default function Feed() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (withLocation: boolean) => {
    setError(null);
    try {
      if (withLocation) await syncNow().catch(() => null);
      const { alerts } = await api.alerts();
      setAlerts(alerts.filter((a) => a.delivery !== 'suppressed'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await session.clear(); // account was deleted or token lost → start over
        router.replace('/onboarding');
        return;
      }
      setError('Keine Verbindung. Zieh nach unten, um es erneut zu versuchen.');
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
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={s.muted}>Letzte 7 Tage in deiner Nähe</Text>
            <Link href="/settings" style={{ color: colors.brand, fontSize: 15, fontWeight: '600' }}>Einstellungen</Link>
          </View>
        }
        ListEmptyComponent={
          loading ? undefined : (
            <View style={{ alignItems: 'center', marginTop: 80, paddingHorizontal: 24 }}>
              <Text style={{ fontSize: 40 }}>👌</Text>
              <Text style={[s.h1, { fontSize: 22, marginTop: 12, textAlign: 'center' }]}>
                {error ? 'Hm.' : 'Alles okay.'}
              </Text>
              <Text style={[s.muted, { textAlign: 'center', marginTop: 6 }]}>
                {error ?? 'Gerade gibt es nichts, das dich betrifft. Wir melden uns, wenn sich das ändert.'}
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
