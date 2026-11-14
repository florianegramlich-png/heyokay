import '../lib/location'; // registers the background location task at startup
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { alertIdFrom, setupChannels } from '../lib/notifications';
import { colors } from '../lib/theme';

export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    setupChannels();
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
        <Stack.Screen name="alert/[id]" options={{ title: 'Warnung' }} />
        <Stack.Screen name="settings" options={{ title: 'Einstellungen' }} />
      </Stack>
    </>
  );
}
