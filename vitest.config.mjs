import { defineConfig } from "vitest/config";

// Vitest configuration for zcode-model-router.
// - Unit tests import the hook lib modules (hooks/scripts/lib/*.mjs) directly.
// - Contract tests spawn the hook scripts as child processes with fixture
//   stdin payloads, asserting the strict stdout JSON zcode expects.
// - Tests live under test/ and never ship with the plugin directory layout.
export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.mjs"],
    exclude: ["node_modules/**", "dist/**", "tmp/**"],
    environment: "node",
    testTimeout: 30000,
  },
});
