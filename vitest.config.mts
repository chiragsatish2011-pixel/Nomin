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
    // parseChatRequest now refuses a request when the deployment holds no
    // credential at all — the check that makes a missing key fail at the door
    // instead of deep in the stack. Offline suites still need to exercise
    // parsing, so give them a non-live placeholder. TRION_LIVE runs keep the
    // real key from the environment.
    env: process.env.TRION_LIVE
      ? {}
      : { TRION_API_KEY: "test-placeholder-not-a-real-key", TRION_DEBUG_PROVIDER: "0" },
  },
});
