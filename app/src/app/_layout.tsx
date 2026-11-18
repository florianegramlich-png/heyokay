import '../lib/location'; // registers the background location task at startup
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import { ErrorScreen } from '../components/ErrorScreen';
import { initCrashReporting } from '../lib/crash';
import { loadLanguage, useI18n } from '../lib/i18n';
import { flushPendingFeedback } from '../lib/feedback-queue';
import { handleResponse, registerNotificationTask, setupCategories, setupChannels } from '../lib/notifications';
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
    setupCategories(lang);
  }, [lang]);

  useEffect(() => {
    void initCrashReporting();
    void registerNotificationTask();
    void flushPendingFeedback(); // ratings tapped while offline or in the background
    const open = async (r: Notifications.NotificationResponse | null) => {
      const id = r && (await handleResponse(r)); // a rating button records it; a tap opens the alert
      if (id) router.push({ pathname: '/alert/[id]', params: { id } });
    };
    // Cold start from a notification tap, then taps while running.
    Notifications.getLastNotificationResponseAsync().then(open);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [router]);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          headerTintColor: colors.cyan,
          headerTitleStyle: { color: colors.text },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen
          name="feed"
          options={{
            headerBackVisible: false,
            headerTitle: () => <Logo />,
            headerRight: () => (
              <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" hitSlop={10}>
                <Text style={{ color: colors.muted, fontSize: 15, fontWeight: '600' }}>{t('nav.settings')}</Text>
              </Pressable>
            ),
          }}
        />
        <Stack.Screen name="alert/[id]" options={{ title: t('nav.alert') }} />
        <Stack.Screen name="settings" options={{ title: t('nav.settings') }} />
      </Stack>
    </>
  );
}

/** "Hey-Okay" in the logo's two colours (the web app uses a cyan→purple gradient). */
function Logo() {
  return (
    <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700' }}>
      <Text style={{ color: colors.cyan }}>Hey-</Text>
      <Text style={{ color: colors.brand }}>Okay</Text>
    </Text>
  );
}
