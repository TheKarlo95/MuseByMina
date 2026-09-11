import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next regenerates these on every dev boot; we keep our own docs.
  agentRules: false,
};

export default nextConfig;
