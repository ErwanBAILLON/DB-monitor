/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // instrumentation.ts starts the fleet checker (Next 14 opt-in).
  experimental: {
    instrumentationHook: true,
    // Database drivers stay outside the server bundle (native/dynamic requires).
    serverComponentsExternalPackages: ["pg", "mysql2", "ioredis", "mongodb", "mssql", "node-sqlite3-wasm"],
    // The WASM binary is loaded at runtime by node-sqlite3-wasm and is not traced.
    outputFileTracingIncludes: { "/**/*": ["./node_modules/node-sqlite3-wasm/dist/*"] },
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
