import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';
import type { Checkin, CheckinAnswer } from '../lib/family';
import { Button, Card, s } from './ui';

/**
 * "Hey, okay?" (PRD 6.1 #8): after a severe event where you are, one tap tells your family how you
 * are. Shown on the Now screen and on the alert's detail. Hey-Okay never calls anyone itself; after
 * "Bitte meldet euch" the card names the emergency number, calmly, for you to call if you need it.
 * Same card as on the web (web/components/checkin-card.tsx).
 */
export function CheckinCard({ checkin, onAnswered }: { checkin: Checkin; onAnswered?: (next: Checkin) => void }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(checkin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const answer = async (a: CheckinAnswer) => {
    setBusy(true); setError(false);
    try {
      const { checkin: next } = await api.answerCheckin(current.id, a);
      setCurrent(next);
      onAnswered?.(next);
    } catch {
      setError(true);
    } finally { setBusy(false); }
  };

  return (
    <Card style={{ marginBottom: 12, backgroundColor: colors.cyanSoft, borderColor: 'rgba(34,211,238,0.35)' }}>
      <Text style={[s.h1, { fontSize: 20 }]} accessibilityRole="header">{t('fam.ci.title')}</Text>
      {current.title ? <Text style={[s.p, { marginTop: 4 }]}>{t('fam.ci.body', { what: current.title })}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
        <View style={{ flex: 1 }}>
          <Button kind={current.answer === 'ok' ? 'primary' : 'secondary'} title={t('fam.ci.ok')} disabled={busy} onPress={() => void answer('ok')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button kind={current.answer === 'call_me' ? 'primary' : 'secondary'} title={t('fam.ci.callMe')} disabled={busy} onPress={() => void answer('call_me')} />
        </View>
      </View>
      {current.answer ? <Text style={[s.p, { marginTop: 8 }]} accessibilityLiveRegion="polite">{t('fam.ci.told')}</Text> : null}
      {current.answer === 'call_me' ? (
        <Text style={{ color: colors.cyan, fontWeight: '600', marginTop: 6 }} accessibilityRole="link" onPress={() => void Linking.openURL(`tel:${current.emergency}`)}>
          {t('fam.ci.emergency', { number: current.emergency })}
        </Text>
      ) : null}
      <Text style={[s.muted, { marginTop: 8, fontSize: 13 }]}>{t('fam.ci.private')}</Text>
      {error ? <Text style={{ color: colors.danger, marginTop: 8 }} accessibilityLiveRegion="polite">{t('fam.ci.error')}</Text> : null}
    </Card>
  );
}
