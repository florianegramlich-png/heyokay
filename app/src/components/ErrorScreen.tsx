import type { ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { reportError } from '../lib/crash';
import { colors } from '../lib/theme';
import { Button } from './ui';

/** Calm fallback for a screen that threw while rendering. Reports the error, then offers a retry. */
export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    reportError(error, 'error-boundary');
  }, [error]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.bg }}>
      <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 8 }}>
        Hier hat etwas nicht geklappt.
      </Text>
      <Text style={{ fontSize: 16, color: colors.muted, marginBottom: 16 }}>
        Das liegt an der App, nicht an dir. Versuch es bitte gleich noch einmal.
      </Text>
      <Button title="Nochmal versuchen" onPress={() => { void retry(); }} />
    </View>
  );
}
