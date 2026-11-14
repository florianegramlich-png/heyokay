import AsyncStorage from '@react-native-async-storage/async-storage';

// The device token is the only credential. It's stored on the device; the server keeps just its hash.
const TOKEN_KEY = 'heyokay.token';
const ONBOARDED_KEY = 'heyokay.onboarded';

export const session = {
  getToken: () => AsyncStorage.getItem(TOKEN_KEY),
  setToken: (t: string) => AsyncStorage.setItem(TOKEN_KEY, t),
  isOnboarded: async () => (await AsyncStorage.getItem(ONBOARDED_KEY)) === '1',
  setOnboarded: () => AsyncStorage.setItem(ONBOARDED_KEY, '1'),
  clear: () => AsyncStorage.multiRemove([TOKEN_KEY, ONBOARDED_KEY]),
};
