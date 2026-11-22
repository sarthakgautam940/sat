import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath,
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  turbopack: { root: process.cwd() },
  env: {
    // The site's main address. Progress is saved per address, so every other address of the
    // site (each deployment has its own) moves its progress here (see lib/sync.ts). On Vercel
    // this is the production domain; elsewhere (local dev) it is empty and nothing moves.
    NEXT_PUBLIC_CANONICAL_HOST: process.env.NEXT_PUBLIC_CANONICAL_HOST ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "",
    // which other addresses count as the site's own (every Vercel deployment and alias)
    NEXT_PUBLIC_SITE_SUFFIX: process.env.NEXT_PUBLIC_SITE_SUFFIX ?? ".vercel.app",
  },
};

export default nextConfig;
