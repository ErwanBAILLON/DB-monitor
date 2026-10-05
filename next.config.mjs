/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // instrumentation.ts starts the fleet checker (Next 14 opt-in).
  experimental: {
    instrumentationHook: true,
    // Database drivers stay outside the server bundle (native/dynamic requires).
    serverComponentsExternalPackages: ["pg", "mysql2", "ioredis"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};
export default nextConfig;
