import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  allowedDevOrigins: ['exterior-frames-hearings-temp.trycloudflare.com'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'omg-gelato79.pages.dev' },
      { protocol: 'https', hostname: 'profile.line-scdn.net' },
    ],
  },
  async redirects() {
    return [
      {
        source: '/menu',
        destination: '/menu/index.html',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/menu/',
        destination: '/menu/index.html',
      },
    ];
  },
};
export default nextConfig;
