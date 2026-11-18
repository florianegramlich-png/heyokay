import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Text, View } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import { SkyScreen } from '../../components/Starfield';
import { Button, Card, Pill, s } from '../../components/ui';
import { api } from '../../lib/api';
import { loadDetail, saveDetail } from '../../lib/offline';
import { useI18n } from '../../lib/i18n';
import { categoryColor, colors, severityColor } from '../../lib/theme';
import type { AlertDetail, Feedback } from '../../lib/types';

export default function AlertScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [error, setError] = useState(false);
  const { t, categoryLabel, severityLabel, timeAgo, locale } = useI18n();

  useEffect(() => {
    api.alert(id)
      .then((d) => { setDetail(d); setFeedback(d.alert.feedback); void saveDetail(d); })
      // Offline: the saved copy, if this alert was opened before.
      .catch(async () => { const d = await loadDetail(id); if (d) { setDetail(d); setFeedback(d.alert.feedback); } else setError(true); });
  }, [id]);

  if (error) return <SkyScreen><Text style={[s.muted, { padding: 24 }]}>{t('alert.gone')}</Text></SkyScreen>;
  if (!detail) return <SkyScreen><ActivityIndicator style={{ marginTop: 40 }} color={colors.cyan} /></SkyScreen>;

  const { alert, sources, summary, endsAt } = detail;
  const color = severityColor[alert.severity];
  const delta = Math.max(0.01, (alert.radiusM / 111_000) * 3);

  async function rate(value: Feedback) {
    setFeedback(value); // optimistic
    await api.feedback(alert.id, value).catch(() => setFeedback(alert.feedback));
  }

  return (
    <SkyScreen>
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
        <Pill text={categoryLabel(alert.category)} color={categoryColor[alert.category]} />
        {alert.kind === 'all_clear' ? <Pill text={t('alert.kind.allClear')} color={colors.good} />
          : alert.kind === 'update' ? <Pill text={t('alert.kind.update')} color={color} />
          : <Pill text={severityLabel(alert.severity)} color={color} />}
        {alert.official ? <Pill text={t('alert.official')} color={colors.cyan} /> : null}
      </View>
      <Text style={[s.h1, { fontSize: 24 }]}>{alert.title}</Text>
      <Text style={[s.p, { marginTop: 8 }]}>{alert.body}</Text>
      <Text style={[s.muted, { marginTop: 6 }]}>
        {timeAgo(alert.createdAt)}
        {endsAt ? ` · ${t('alert.until', { time: new Date(endsAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}` : ''}
        {alert.matchedPlace ? ` · ${t('alert.affects', { place: alert.matchedPlace })}` : ''}
      </Text>

      {endsAt && Date.parse(endsAt) <= Date.now() ? (
        <Text style={[s.muted, { marginTop: 10 }]}>{t('alert.endedNote')}</Text>
      ) : null}

      <Card style={{ marginTop: 16, backgroundColor: colors.cyanSoft, borderColor: 'rgba(34,211,238,0.35)' }}>
        <Text style={{ fontWeight: '700', color: colors.cyan, marginBottom: 4, textTransform: 'uppercase', fontSize: 12, letterSpacing: 0.8 }}>{t('alert.whatToDo')}</Text>
        <Text style={s.p}>{alert.action}</Text>
      </Card>

      <View style={{ height: 200, borderRadius: 16, overflow: 'hidden', marginTop: 16, borderWidth: 1, borderColor: colors.line }}>
        <MapView
          style={{ flex: 1 }}
          initialRegion={{ latitude: alert.lat, longitude: alert.lon, latitudeDelta: delta, longitudeDelta: delta }}
          pitchEnabled={false}
          rotateEnabled={false}
          userInterfaceStyle="dark"
        >
          <Circle center={{ latitude: alert.lat, longitude: alert.lon }} radius={alert.radiusM} strokeColor={color} fillColor={`${color}22`} />
          <Marker coordinate={{ latitude: alert.lat, longitude: alert.lon }} pinColor={color} />
        </MapView>
      </View>

      {summary ? (
        <Card style={{ marginTop: 16 }}>
          <Text style={{ fontWeight: '700', marginBottom: 4, color: colors.text }}>{t('alert.summary')}</Text>
          <Text style={s.p}>{summary}</Text>
        </Card>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <Text style={{ fontWeight: '700', marginBottom: 6, color: colors.text }}>{t('alert.sources')}</Text>
        {sources.map((src, i) => (
          <Text
            key={i}
            style={[s.p, { color: src.url ? colors.cyan : colors.text, marginBottom: 6 }]}
            onPress={src.url ? () => Linking.openURL(src.url!) : undefined}
          >
            {src.official ? '● ' : '○ '}{src.sourceName}: {src.title}
          </Text>
        ))}
        {alert.aiWritten ? (
          <Text style={[s.muted, { marginTop: 4, fontSize: 12 }]}>
            {t('alert.aiNote')}
          </Text>
        ) : null}
      </Card>

      <Text style={[s.sectionTitle, { marginTop: 24 }]}>{t('alert.relevant')}</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button kind={feedback === 'relevant' ? 'primary' : 'secondary'} title={t('alert.yes')} onPress={() => rate('relevant')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button kind={feedback === 'not_relevant' ? 'primary' : 'secondary'} title={t('alert.no')} onPress={() => rate('not_relevant')} />
        </View>
      </View>
      {feedback ? <Text style={[s.muted, { marginTop: 8 }]}>{t('alert.thanks')}</Text> : null}
    </ScrollView>
    </SkyScreen>
  );
}
