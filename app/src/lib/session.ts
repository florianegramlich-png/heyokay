import AsyncStorage from '@react-native-async-storage/async-storage';

// The device token is the only credential. It's stored on the device; the server keeps just its hash.
const TOKEN_KEY = 'heyokay.token';
const ONBOARDED_KEY = 'heyokay.onboarded';

export const session = {
  getToken: () => AsyncStorage.getItem(TOKEN_KEY),
  setToken: (t: string) => AsyncStorage.setItem(TOKEN_KEY, t),
  isOnboarded: async () => (await AsyncStorage.getItem(ONBOARDED_KEY)) === '1',
  setOnboarded: () => AsyncStorage.setItem(ONBOARDED_KEY, '1'),
  /** Sign-out / delete: the token, onboarding flag and the offline copy of alerts. */
  clear: async () => {
    const offline = (await AsyncStorage.getAllKeys().catch(() => [] as readonly string[])).filter((k) => k.startsWith('heyokay.offline.'));
    await AsyncStorage.multiRemove([TOKEN_KEY, ONBOARDED_KEY, ...offline]);
  },
};
