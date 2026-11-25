import Constants from 'expo-constants';
import { session } from './session';
import { createApi } from './api-client';

export { ApiError, createApi } from './api-client';

/** EXPO_PUBLIC_API_URL wins (e.g. a tunnel to a local server), else app.json extra.apiUrl (the hosted server). */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'https://heyokay.fly.dev';

export const api = createApi((...a) => fetch(...a), () => session.getToken(), API_URL);
