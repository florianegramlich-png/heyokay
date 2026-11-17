import { Pressable, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { colors, severityColor } from '../lib/theme';
import type { Alert } from '../lib/types';
import { Card, Pill, s } from './ui';

export function AlertCard({ alert, onPress }: { alert: Alert; onPress: () => void }) {
  const { t, categoryLabel, timeAgo } = useI18n();
  const color = severityColor[alert.severity];
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Card style={{ marginBottom: 10, borderLeftWidth: 4, borderLeftColor: color }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
          <Pill text={categoryLabel(alert.category)} color={color} />
          <Text style={s.muted}>{timeAgo(alert.createdAt)}</Text>
        </View>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>{alert.title}</Text>
        <Text style={[s.p, { marginTop: 4 }]}>{alert.body}</Text>
        <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>
          {alert.official ? `${t('alert.official')} · ` : ''}{alert.sourceName}{alert.aiWritten ? ` · ${t('alert.aiWritten')}` : ''}
        </Text>
      </Card>
    </Pressable>
  );
}
