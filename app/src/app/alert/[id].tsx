import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Text, View } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import { Button, Card, Pill, s } from '../../components/ui';
import { api } from '../../lib/api';
import { colors, severityColor, severityLabel, timeAgo } from '../../lib/theme';
import { CATEGORY_LABEL, type AlertDetail, type Feedback } from '../../lib/types';

export default function AlertScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.alert(id)
      .then((d) => { setDetail(d); setFeedback(d.alert.feedback); })
      .catch(() => setError(true));
  }, [id]);

  if (error) return <Text style={[s.muted, { padding: 24 }]}>Diese Warnung ist nicht mehr verfügbar.</Text>;
  if (!detail) return <ActivityIndicator style={{ marginTop: 40 }} color={colors.brand} />;

  const { alert, sources, summary, endsAt } = detail;
  const color = severityColor[alert.severity];
  const delta = Math.max(0.01, (alert.radiusM / 111_000) * 3);

  async function rate(value: Feedback) {
    setFeedback(value); // optimistic
    await api.feedback(alert.id, value).catch(() => setFeedback(alert.feedback));
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
        <Pill text={CATEGORY_LABEL[alert.category]} color={color} />
        <Pill text={severityLabel[alert.severity]} color={color} />
        {alert.official ? <Pill text="Amtlich" color={colors.text} /> : null}
      </View>
      <Text style={[s.h1, { fontSize: 24 }]}>{alert.title}</Text>
      <Text style={[s.p, { marginTop: 8 }]}>{alert.body}</Text>
      <Text style={[s.muted, { marginTop: 6 }]}>
        {timeAgo(alert.createdAt)}
        {endsAt ? ` · bis ${new Date(endsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : ''}
        {alert.matchedPlace ? ` · betrifft „${alert.matchedPlace}“` : ''}
      </Text>

      <Card style={{ marginTop: 16, backgroundColor: colors.brandSoft, borderColor: colors.brandSoft }}>
        <Text style={{ fontWeight: '700', color: colors.brand, marginBottom: 4 }}>Was du tun kannst</Text>
        <Text style={s.p}>{alert.action}</Text>
      </Card>

      <View style={{ height: 200, borderRadius: 14, overflow: 'hidden', marginTop: 16 }}>
        <MapView
          style={{ flex: 1 }}
          initialRegion={{ latitude: alert.lat, longitude: alert.lon, latitudeDelta: delta, longitudeDelta: delta }}
          pitchEnabled={false}
          rotateEnabled={false}
        >
          <Circle center={{ latitude: alert.lat, longitude: alert.lon }} radius={alert.radiusM} strokeColor={color} fillColor={`${color}22`} />
          <Marker coordinate={{ latitude: alert.lat, longitude: alert.lon }} pinColor={color} />
        </MapView>
      </View>

      {summary ? (
        <Card style={{ marginTop: 16 }}>
          <Text style={{ fontWeight: '700', marginBottom: 4, color: colors.text }}>Zusammenfassung</Text>
          <Text style={s.p}>{summary}</Text>
        </Card>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <Text style={{ fontWeight: '700', marginBottom: 6, color: colors.text }}>Quellen</Text>
        {sources.map((src, i) => (
          <Text
            key={i}
            style={[s.p, { color: src.url ? colors.brand : colors.text, marginBottom: 6 }]}
            onPress={src.url ? () => Linking.openURL(src.url!) : undefined}
          >
            {src.official ? '● ' : '○ '}{src.sourceName}: {src.title}
          </Text>
        ))}
        {alert.aiWritten ? (
          <Text style={[s.muted, { marginTop: 4, fontSize: 12 }]}>
            Text von KI formuliert und gegen die Quellen geprüft. Maßgeblich sind die Originalmeldungen.
          </Text>
        ) : null}
      </Card>

      <Text style={[s.sectionTitle, { marginTop: 24 }]}>War das relevant für dich?</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button kind={feedback === 'relevant' ? 'primary' : 'secondary'} title="👍 Ja" onPress={() => rate('relevant')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button kind={feedback === 'not_relevant' ? 'primary' : 'secondary'} title="👎 Nein" onPress={() => rate('not_relevant')} />
        </View>
      </View>
      {feedback ? <Text style={[s.muted, { marginTop: 8 }]}>Danke – wir passen künftige Warnungen an.</Text> : null}
    </ScrollView>
  );
}
