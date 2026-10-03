import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Test harnesses run on Node separately; keep production code strictly checked.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
};

export default nextConfig;
