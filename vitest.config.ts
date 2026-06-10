import { defineConfig } from "vitest/config";
import * as path from "node:path";

/**
 * Vitest config for unit tests. Unit tests live under src/test/unit/**.
 *
 * VS Code's `vscode` module is only available at extension runtime, so we alias it to a tiny
 * stub for tests. Anything beyond what the stub exposes will throw, which is the point — code
 * that uses real VS Code APIs belongs in integration tests (npm run test:integration).
 */
export default defineConfig({
  test: {
    include: ["src/test/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/test/**", "src/extension.ts"],
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/test/__mocks__/vscode.ts"),
    },
  },
});
