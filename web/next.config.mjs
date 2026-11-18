/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
        // Location is used only on the user's tap, by this site itself.
        { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=()' },
      ],
    }];
  },
};
export default nextConfig;
