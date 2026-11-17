import '../lib/location'; // registers the background location task at startup
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ErrorScreen } from '../components/ErrorScreen';
import { initCrashReporting } from '../lib/crash';
import { loadLanguage, useI18n } from '../lib/i18n';
import { alertIdFrom, setupChannels } from '../lib/notifications';
import { colors } from '../lib/theme';

// expo-router renders this when any screen below throws (PRD 5.3 crash reporting).
export const ErrorBoundary = ErrorScreen;

export default function RootLayout() {
  const router = useRouter();
  const { t, lang } = useI18n();

  useEffect(() => {
    void loadLanguage();
  }, []);
  useEffect(() => {
    setupChannels(lang);
  }, [lang]);

  useEffect(() => {
    void initCrashReporting();
    const open = (r: Notifications.NotificationResponse | null) => {
      const id = r && alertIdFrom(r);
      if (id) router.push({ pathname: '/alert/[id]', params: { id } });
    };
    // Cold start from a notification tap, then taps while running.
    Notifications.getLastNotificationResponseAsync().then(open);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [router]);

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          headerTintColor: colors.brand,
          headerTitleStyle: { color: colors.text },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="feed" options={{ title: 'Hey-Okay', headerBackVisible: false }} />
        <Stack.Screen name="alert/[id]" options={{ title: t('nav.alert') }} />
        <Stack.Screen name="settings" options={{ title: t('nav.settings') }} />
      </Stack>
    </>
  );
}
