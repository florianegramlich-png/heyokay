import { Pressable, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { colors, severityColor } from '../lib/theme';
import type { Alert } from '../lib/types';
import { Card, Pill, s } from './ui';

export function AlertCard({ alert, onPress }: { alert: Alert; onPress: () => void }) {
  const { t, categoryLabel, timeAgo } = useI18n();
  const allClear = alert.kind === 'all_clear';
  // All-clears are good news: calm green. Ended warnings fade back.
  const color = allClear ? colors.brand : alert.ended ? colors.muted : severityColor[alert.severity];
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Card style={{ marginBottom: 10, borderLeftWidth: 4, borderLeftColor: color, opacity: alert.ended && !allClear ? 0.6 : 1 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Pill text={allClear ? t('alert.kind.allClear') : categoryLabel(alert.category)} color={color} />
            {alert.kind === 'update' ? <Pill text={t('alert.kind.update')} color={color} /> : null}
            {alert.ended && !allClear ? <Pill text={t('alert.ended')} color={colors.muted} /> : null}
          </View>
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
