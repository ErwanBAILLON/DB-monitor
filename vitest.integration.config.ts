import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests need a reachable Postgres (TEST_PG_URL). See README.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/integration/**/*.test.ts"], testTimeout: 30_000 },
});
