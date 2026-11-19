import { Pressable, Text, View } from 'react-native';
import type { Dashboard as Data, Status } from '../lib/dashboard';
import { useI18n } from '../lib/i18n';
import { categoryColor, colors, severityColor } from '../lib/theme';
import type { Alert, Severity } from '../lib/types';
import { Card, s } from './ui';

/**
 * Overview at the top of the main screen, in the layout of Flori's v0 prototype: status card with
 * a level meter, a tile per topic, and a 24-hour line. Real alerts only; no risk percentages.
 */
export function Dashboard({ data, onOpen }: { data: Data; onOpen: (a: Alert) => void }) {
  const { t, categoryLabel, severityLabel, locale } = useI18n();
  const accent = statusColor(data.status, data.highest);

  return (
    <View style={{ marginBottom: 18 }}>
      {/* Status */}
      <Card style={{ borderColor: hexA(accent, 0.45), backgroundColor: 'rgba(12,14,32,0.82)', paddingVertical: 20, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, flexDirection: 'row' }}>
          <View style={{ flex: 1, backgroundColor: colors.cyan }} />
          <View style={{ flex: 1, backgroundColor: colors.brand }} />
        </View>
        <Text style={[s.muted, { fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }]}>{t('dash.title')}</Text>
        <Text accessibilityRole="header" style={{ color: accent, fontSize: 30, fontWeight: '700', marginTop: 4 }}>
          {t(`dash.status.${data.status}`)}
        </Text>
        <Text style={[s.p, { marginTop: 4, color: 'rgba(244,244,247,0.85)' }]}>
          {data.highest === null
            ? t('dash.status.calmText')
            : t('dash.status.text', { n: data.current, level: severityLabel(data.highest) })}
        </Text>
        <View
          accessible
          accessibilityLabel={`${t('dash.meter')}: ${data.highest ? severityLabel(data.highest) : t('dash.quiet')}`}
          style={{ flexDirection: 'row', gap: 4, marginTop: 14 }}
        >
          {([1, 2, 3, 4, 5] as Severity[]).map((n) => (
            <View
              key={n}
              style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: data.highest && n <= data.highest ? severityColor[n] : 'rgba(255,255,255,0.10)' }}
            />
          ))}
        </View>
        <Text style={[s.muted, { fontSize: 11, marginTop: 6 }]}>{t('dash.meter')}</Text>
      </Card>

      {/* Topics */}
      <Text style={[s.sectionTitle, { marginTop: 18 }]}>{t('dash.topics')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {data.tiles.map((tile) => {
          const active = tile.count > 0;
          const color = categoryColor[tile.category];
          return (
            <Pressable
              key={tile.category}
              disabled={!tile.top}
              onPress={() => tile.top && onOpen(tile.top)}
              accessibilityRole={tile.top ? 'button' : undefined}
              style={({ pressed }) => [{ width: '48%', flexGrow: 1 }, pressed && { opacity: 0.8 }]}
            >
              <Card style={{ padding: 14, minHeight: 92, borderColor: active ? hexA(color, 0.4) : colors.line }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: active ? color : 'rgba(255,255,255,0.18)' }} />
                  <Text numberOfLines={2} style={{ color: colors.text, fontWeight: '600', fontSize: 14, flex: 1 }}>{categoryLabel(tile.category)}</Text>
                </View>
                <Text style={{ color: active ? colors.text : colors.muted, fontSize: active ? 20 : 15, fontWeight: active ? '700' : '500', marginTop: 10 }}>
                  {active ? t('dash.active', { n: tile.count }) : t('dash.quiet')}
                </Text>
                {tile.highest ? (
                  <Text style={{ color: severityColor[tile.highest], fontSize: 12, fontWeight: '600', marginTop: 2 }}>{severityLabel(tile.highest)}</Text>
                ) : null}
              </Card>
            </Pressable>
          );
        })}
      </View>

      {/* Next 24 hours */}
      <Card style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>{t('dash.next24')}</Text>
          <Text style={[s.muted, { fontSize: 13 }]}>
            {data.next24.length ? t('dash.next24.count', { n: data.next24.length }) : t('dash.next24.none')}
          </Text>
        </View>
        <View style={{ height: 22, marginTop: 14, justifyContent: 'center' }}>
          <View style={{ height: 4, borderRadius: 2, flexDirection: 'row', overflow: 'hidden' }}>
            <View style={{ flex: 1, backgroundColor: hexA(colors.cyan, 0.35) }} />
            <View style={{ flex: 1, backgroundColor: hexA(colors.brand, 0.35) }} />
          </View>
          {data.next24.map(({ alert, at }) => (
            <Pressable
              key={alert.id}
              onPress={() => onOpen(alert)}
              accessibilityRole="button"
              accessibilityLabel={alert.title}
              hitSlop={10}
              style={{
                position: 'absolute', left: `${Math.min(Math.max(at, 0), 1) * 100}%`, marginLeft: -7,
                width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: colors.bg,
                backgroundColor: severityColor[alert.severity],
              }}
            />
          ))}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
          <Text style={[s.muted, { fontSize: 11 }]}>{t('dash.nowMark')}</Text>
          <Text style={[s.muted, { fontSize: 11 }]}>
            {new Date(Date.now() + 12 * 3600_000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
          </Text>
          <Text style={[s.muted, { fontSize: 11 }]}>+24 h</Text>
        </View>
        {data.next24.slice(0, 3).map(({ alert }) => (
          <Pressable key={alert.id} onPress={() => onOpen(alert)} style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: severityColor[alert.severity] }} />
            <Text numberOfLines={1} style={[s.muted, { fontSize: 13, minWidth: 72 }]}>
              {new Date(alert.startsAt!).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
            </Text>
            <Text numberOfLines={1} style={{ color: colors.text, fontSize: 14, flex: 1 }}>{alert.title}</Text>
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

function statusColor(status: Status, highest: Severity | null): string {
  if (status === 'calm') return colors.cyan;
  return severityColor[highest ?? 1];
}

/** '#RRGGBB' + alpha → rgba() */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
