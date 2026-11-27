import type { MetadataRoute } from 'next';

/**
 * Web app manifest: lets Android (Chrome, Samsung Internet) install Hey-Okay to the home screen as
 * its own app window, without a store. Served by Next at /manifest.webmanifest.
 * The icons are a simple placeholder mark until there's a real app icon (see ROADMAP "Needs a human").
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Hey-Okay',
    short_name: 'Hey-Okay',
    description: 'Ruhige Warnungen für deine Umgebung: nur was dich betrifft, und was du tun kannst.',
    lang: 'de',
    start_url: '/', // the start page sends new people to onboarding
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0F1430',
    theme_color: '#0F1430',
    categories: ['news', 'utilities', 'weather'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // The mark sits inside the inner 80 %, so Android may crop it into its own shape.
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
