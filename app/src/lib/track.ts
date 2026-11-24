import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { createAnalytics, heyOkayProvider, pushChange, type Platform as AnalyticsPlatform } from './analytics';
import { api } from './api';
import { session } from './session';

/** The app's analytics: anonymous counts to Hey-Okay's server (lib/analytics.ts). */
const platform: AnalyticsPlatform = Platform.OS === 'android' ? 'android' : 'ios';
export const analytics = createAnalytics([heyOkayProvider(platform, (body) => api.events(body))]);

const PUSH_KEY = 'heyokay.pushPermission';

/**
 * When the app comes to the front: were notifications switched off (or on again) in the phone's
 * settings since last time? Only after onboarding, so the first question isn't counted twice.
 */
export async function checkPushPermission() {
  if (!(await session.isOnboarded())) return;
  const now = (await Notifications.getPermissionsAsync()).granted;
  const stored = await AsyncStorage.getItem(PUSH_KEY);
  const event = pushChange(stored === null ? null : stored === '1', now);
  if (event) analytics.track(event);
  if (stored !== (now ? '1' : '0')) await AsyncStorage.setItem(PUSH_KEY, now ? '1' : '0');
}
