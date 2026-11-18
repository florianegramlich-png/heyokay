import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View, type ViewStyle } from 'react-native';
import { colors } from '../lib/theme';

export function Button({ title, onPress, kind = 'primary', disabled }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.btn, s[kind], (pressed || disabled) && { opacity: 0.6 }]}
    >
      <Text style={[s.btnText, kind !== 'primary' && { color: kind === 'danger' ? colors.danger : colors.text }]}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ marginTop: 24 }}>
      <Text style={s.sectionTitle}>{title}</Text>
      <Card>{children}</Card>
    </View>
  );
}

export function ToggleRow({ label, hint, value, onChange, last }: {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; last?: boolean;
}) {
  return (
    <View style={[s.row, !last && s.rowLine]}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={s.rowLabel}>{label}</Text>
        {hint ? <Text style={s.rowHint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.brand, false: 'rgba(255,255,255,0.18)' }} thumbColor="#FFFFFF" ios_backgroundColor="rgba(255,255,255,0.18)" />
    </View>
  );
}

export function Pill({ text, color }: { text: string; color: string }) {
  return (
    <View style={[s.pill, { borderColor: color, backgroundColor: `${color}22` }]}>
      <Text style={[s.pillText, { color }]}>{text}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  btn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  primary: { backgroundColor: colors.brand },
  secondary: { backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.line },
  danger: { backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: 'rgba(248,113,113,0.35)' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.line },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { fontSize: 16, color: colors.text },
  rowHint: { fontSize: 13, color: colors.muted, marginTop: 2 },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '600' },
  h1: { fontSize: 28, fontWeight: '700', color: colors.text },
  p: { fontSize: 16, lineHeight: 23, color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
});
