import type { ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { reportError } from '../lib/crash';
import { useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';
import { Button } from './ui';

/** Calm fallback for a screen that threw while rendering. Reports the error, then offers a retry. */
export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  const { t } = useI18n();
  useEffect(() => {
    reportError(error, 'error-boundary');
  }, [error]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.bg }}>
      <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
        {t('err.title')}
      </Text>
      <Text style={{ fontSize: 16, color: colors.muted, marginBottom: 16 }}>
        {t('err.text')}
      </Text>
      <Button title={t('err.retry')} onPress={() => { void retry(); }} />
    </View>
  );
}
