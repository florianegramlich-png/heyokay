import { Pressable, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { categoryColor, colors, severityColor } from '../lib/theme';
import type { Alert } from '../lib/types';
import { Card, Pill, s } from './ui';

export function AlertCard({ alert, onPress, showCategory = false }: { alert: Alert; onPress: () => void; showCategory?: boolean }) {
  const { t, categoryLabel, severityLabel, timeAgo } = useI18n();
  const allClear = alert.kind === 'all_clear';
  // All-clears are good news: calm green. Ended warnings fade back.
  const color = allClear ? colors.good : alert.ended ? colors.muted : severityColor[alert.severity];
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => pressed && { opacity: 0.8 }}>
      <Card style={{ marginBottom: 10, opacity: alert.ended && !allClear ? 0.65 : 1 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', flex: 1 }}>
            <Pill text={allClear ? t('alert.kind.allClear') : severityLabel(alert.severity)} color={color} />
            {alert.kind === 'update' ? <Pill text={t('alert.kind.update')} color={colors.muted} /> : null}
            {alert.ended && !allClear ? <Pill text={t('alert.ended')} color={colors.muted} /> : null}
            {alert.official ? <Pill text={t('alert.official')} color={colors.cyan} /> : null}
            {showCategory ? <Pill text={categoryLabel(alert.category)} color={categoryColor[alert.category]} /> : null}
          </View>
          <Text style={[s.muted, { fontSize: 12, marginLeft: 8 }]}>{timeAgo(alert.createdAt)}</Text>
        </View>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>{alert.title}</Text>
        <Text style={[s.p, { marginTop: 4, color: 'rgba(244,244,247,0.85)' }]}>{alert.body}</Text>
        <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>
          {alert.matchedPlace ? `${alert.matchedPlace} · ` : ''}{alert.sourceName}{alert.aiWritten ? ` · ${t('alert.aiWritten')}` : ''}
        </Text>
      </Card>
    </Pressable>
  );
}
