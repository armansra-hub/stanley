/** @type {import('next').NextConfig} */
const nextConfig = {
  // Long-running ingestion runs in cron/webhook routes, never in page loads.
  experimental: {},
};

export default nextConfig;
