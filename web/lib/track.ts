import { createAnalytics, heyOkayProvider } from './analytics';
import { api } from './api';

/**
 * The web app's analytics: anonymous counts to Hey-Okay's server (lib/analytics.ts), the same
 * events as the phone app minus what a browser doesn't have (location "always", notifications).
 */
export const analytics = createAnalytics([heyOkayProvider('web', (body) => api.events(body))]);
