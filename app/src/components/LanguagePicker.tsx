import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { LANGUAGES, useI18n, type Lang } from '../lib/i18n';
import { colors } from '../lib/theme';

/**
 * Language dropdown: shows the current language; tapping opens a list to choose from.
 * Scales to more languages (a list, not side-by-side buttons). `compact` = small, centred
 * (onboarding); otherwise a full-width row (settings).
 */
export function LanguagePicker({ value, onChange, compact = false }: { value: Lang; onChange: (l: Lang) => void; compact?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const current = LANGUAGES.find((l) => l.code === value)?.name ?? value;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${t('set.language')}: ${current}`}
        accessibilityHint={t('set.language')}
        hitSlop={8}
        style={compact
          ? { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 6, marginTop: 20, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.line }
          : { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(255,255,255,0.04)' }}
      >
        <Text style={{ color: colors.text, fontSize: 15 }}>🌐  {current}</Text>
        <Text style={{ color: colors.muted, fontSize: 12 }}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 32 }}>
          <View accessibilityRole="menu" style={{ backgroundColor: colors.bg, borderRadius: 14, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
            <Text style={{ color: colors.muted, fontSize: 13, padding: 14, paddingBottom: 6 }}>{t('set.language')}</Text>
            {LANGUAGES.map((l) => {
              const selected = l.code === value;
              return (
                <Pressable
                  key={l.code}
                  onPress={() => { setOpen(false); if (!selected) onChange(l.code); }}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected }}
                  style={({ pressed }) => ({ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 16, backgroundColor: pressed ? 'rgba(255,255,255,0.06)' : 'transparent' })}
                >
                  <Text style={{ color: colors.text, fontSize: 16, fontWeight: selected ? '700' : '400' }}>{l.name}</Text>
                  {selected && <Text style={{ color: colors.brand, fontSize: 16 }}>✓</Text>}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
