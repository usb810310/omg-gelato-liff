import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  trailingSlash: true,
  allowedDevOrigins: ['exterior-frames-hearings-temp.trycloudflare.com'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'omg-gelato79.pages.dev' },
      { protocol: 'https', hostname: 'profile.line-scdn.net' },
    ],
  },
};
export default nextConfig;
