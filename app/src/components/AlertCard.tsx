import { Pressable, Text, View } from 'react-native';
import { colors, severityColor, timeAgo } from '../lib/theme';
import { CATEGORY_LABEL, type Alert } from '../lib/types';
import { Card, Pill, s } from './ui';

export function AlertCard({ alert, onPress }: { alert: Alert; onPress: () => void }) {
  const color = severityColor[alert.severity];
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Card style={{ marginBottom: 10, borderLeftWidth: 4, borderLeftColor: color }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
          <Pill text={CATEGORY_LABEL[alert.category]} color={color} />
          <Text style={s.muted}>{timeAgo(alert.createdAt)}</Text>
        </View>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>{alert.title}</Text>
        <Text style={[s.p, { marginTop: 4 }]}>{alert.body}</Text>
        <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>
          {alert.official ? 'Amtlich · ' : ''}{alert.sourceName}{alert.aiWritten ? ' · KI-formuliert' : ''}
        </Text>
      </Card>
    </Pressable>
  );
}
