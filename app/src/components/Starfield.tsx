import { memo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { colors } from '../lib/theme';

/**
 * The night sky behind every screen: small cyan, purple and pink stars with a soft glow.
 * Still (no animation, so no battery cost and nothing distracting), and the same on every screen.
 */
export const Starfield = memo(function Starfield() {
  const { width, height } = useWindowDimensions();
  const count = Math.round((width * height) / 9000);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const stars = Array.from({ length: count }, (_, i) => {
    const r = 0.8 + rnd() * 1.6;
    return { key: i, left: rnd() * width, top: rnd() * height, r, color: colors.star[Math.floor(rnd() * 3)], glow: rnd() < 0.35 };
  });
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1E1B4B', opacity: 0.35, top: height * 0.45 }]} />
      {stars.map((s) => (
        <View key={s.key} style={{ position: 'absolute', left: s.left, top: s.top }}>
          {s.glow ? (
            <View style={{ position: 'absolute', left: -s.r * 2, top: -s.r * 2, width: s.r * 5, height: s.r * 5, borderRadius: s.r * 3, backgroundColor: s.color, opacity: 0.18 }} />
          ) : null}
          <View style={{ width: s.r, height: s.r, borderRadius: s.r, backgroundColor: s.color, opacity: 0.85 }} />
        </View>
      ))}
    </View>
  );
});

/** A screen with the night sky behind it. */
export function SkyScreen({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flex: 1 }}>
      <Starfield />
      {children}
    </View>
  );
}
