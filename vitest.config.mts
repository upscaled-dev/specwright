import { defineConfig } from "vitest/config";
import * as path from "node:path";
import { browserClientCoveragePlugin } from "./src/test/unit/helpers/browser-client-bundle.mts";

/**
 * Vitest config for unit tests. Unit tests live under src/test/unit/**.
 *
 * VS Code's `vscode` module is only available at extension runtime, so we alias it to a tiny
 * stub for tests. Anything beyond what the stub exposes will throw; code
 * that uses real VS Code APIs belongs in integration tests (npm run test:integration).
 */
export default defineConfig({
  plugins: [browserClientCoveragePlugin()],
  test: {
    include: ["src/test/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/test/**", "src/extension.ts"],
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 95,
      },
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(import.meta.dirname, "src/test/__mocks__/vscode.ts"),
    },
  },
});
