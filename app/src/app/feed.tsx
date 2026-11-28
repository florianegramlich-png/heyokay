import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { AlertCard } from '../components/AlertCard';
import { CheckinCard } from '../components/CheckinCard';
import { Dashboard } from '../components/Dashboard';
import { SkyScreen } from '../components/Starfield';
import { Card, s } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { buildDashboard } from '../lib/dashboard';
import { checkinToShow, type Checkin } from '../lib/family';
import { aheadAlerts, byCategory, earlierAlerts } from '../lib/feed';
import { useI18n } from '../lib/i18n';
import { locationAccess, syncNow } from '../lib/location';
import { session } from '../lib/session';
import { loadFeed, saveFeed } from '../lib/offline';
import { categoryColor, colors } from '../lib/theme';
import { CATEGORIES, type Alert, type Category } from '../lib/types';

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
  /** Set when showing the saved copy because the server can't be reached. */
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  /** Topics the person follows (dashboard tiles); all of them until /v1/me answers. */
  const [followed, setFollowed] = useState<readonly Category[]>(CATEGORIES);
  /** "Hey, okay?" (only for people in a family, after a severe event where they are). */
  const [checkin, setCheckin] = useState<Checkin | null>(null);
  const { t, categoryLabel, locale } = useI18n();

  const load = useCallback(async (withLocation: boolean) => {
    setError(false);
    try {
      setNoLocation((await locationAccess()) === 'denied');
      if (withLocation) await syncNow().catch(() => null);
      const [{ alerts }, me, cis] = await Promise.all([api.alerts(), api.me().catch(() => null), api.checkins().catch(() => null)]);
      if (me) setFollowed(me.prefs.categories);
      if (cis) setCheckin(checkinToShow(cis.checkins));
      const visible = alerts.filter((a) => a.delivery !== 'suppressed');
      setAlerts(visible);
      setOfflineSince(null);
      void saveFeed(visible);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await session.clear(); // account was deleted or token lost → start over
        router.replace('/onboarding');
        return;
      }
      const cached = await loadFeed();
      if (cached) { setAlerts(cached.alerts); setOfflineSince(cached.savedAt); }
      else setError(true);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useFocusEffect(useCallback(() => { load(true); }, [load]));

  const open = (a: Alert) => router.push({ pathname: '/alert/[id]', params: { id: a.id } });
  const groups = byCategory(alerts);
  const earlier = earlierAlerts(alerts);
  const ahead = aheadAlerts(alerts);
  const dashboard = buildDashboard(alerts, followed);

  return (
    <SkyScreen>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { setLoading(true); load(true); }} tintColor={colors.cyan} />}
      >
        <Text style={[s.h1, { fontSize: 26 }]}>{t('feed.now')}</Text>
        <Text style={[s.muted, { marginTop: 2, marginBottom: 14 }]}>{t('feed.now.subtitle')}</Text>

        {offlineSince ? (
          <Card style={{ marginBottom: 12 }}>
            <Text style={s.p}>{t('feed.offline', { time: new Date(offlineSince).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}</Text>
          </Card>
        ) : null}

        {noLocation ? (
          <Card style={{ marginBottom: 12, backgroundColor: colors.cyanSoft, borderColor: 'rgba(34,211,238,0.3)' }}>
            <Text style={s.p}>{t('feed.noLocation')}</Text>
            <Text style={{ color: colors.cyan, fontWeight: '600', marginTop: 6 }} onPress={() => Linking.openSettings()}>
              {t('feed.noLocation.cta')}
            </Text>
          </Card>
        ) : null}

        {checkin && !offlineSince ? <CheckinCard key={checkin.id} checkin={checkin} /> : null}

        {!loading && !error ? <Dashboard data={dashboard} onOpen={open} /> : null}

        {!loading && groups.length === 0 && error ? (
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

        {ahead.length ? (
          <View style={{ marginTop: 16 }}>
            <Text style={s.sectionTitle}>{t('feed.ahead')}</Text>
            {ahead.map((a) => (
              <View key={a.id}>
                <Text style={[s.muted, { fontSize: 13, marginBottom: 4 }]}>
                  {t('feed.ahead.from', { time: new Date(a.startsAt!).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}
                </Text>
                <AlertCard alert={a} onPress={() => open(a)} showCategory />
              </View>
            ))}
          </View>
        ) : null}

        {earlier.length ? (
          <View style={{ marginTop: 16 }}>
            <Text style={s.sectionTitle}>{t('feed.earlier')}</Text>
            {earlier.map((a) => <AlertCard key={a.id} alert={a} onPress={() => open(a)} showCategory />)}
          </View>
        ) : null}

        {!loading && !offlineSince ? (
          <Pressable onPress={() => router.push('/history')} accessibilityRole="button" style={{ alignItems: 'center', paddingVertical: 16, marginTop: 8 }}>
            <Text style={{ color: colors.cyan, fontWeight: '600', fontSize: 15 }}>{t('feed.history')}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SkyScreen>
  );
}
