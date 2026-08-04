import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The repository lives on a mounted volume where Vite's generated cache
  // files can intermittently fail with EPERM. Keep disposable test artifacts
  // on local temp storage so a filesystem quirk cannot masquerade as a test
  // failure or prevent the evaluation harness from writing its report.
  cacheDir: "/tmp/trion-vite-cache",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["lib/**/*.test.ts"],
    // Live tests hit the real model API; they are opt-in via TRION_LIVE=1.
    testTimeout: process.env.TRION_LIVE ? 240_000 : 5_000,
  },
});
