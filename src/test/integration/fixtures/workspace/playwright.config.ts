import { defineConfig } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

const testDir = defineBddConfig({
  features: process.env["SPECWRIGHT_NATIVE_PROGRESS_ROOT"]
    ? "features/progress-outline.feature"
    : process.env["SPECWRIGHT_NATIVE_RETRY_OUTLINE"] === "1"
    ? "features/retry-outline.feature"
    : "features/**/*.feature",
  steps: ["features/steps/**/*.ts"],
});

export default defineConfig({
  testDir,
  reporter: process.env["SPECWRIGHT_NATIVE_PROGRESS_ROOT"]
    ? [["list"], ["json"], [require.resolve("./progress-finishing-reporter.cjs")]]
    : "list",
  ...(process.env["SPECWRIGHT_NATIVE_PROGRESS_ROOT"]
    ? { retries: 1, workers: 1, globalTeardown: require.resolve("./progress-teardown.cjs") }
    : {}),
  ...(process.env["SPECWRIGHT_NATIVE_RETRY_OUTLINE"] === "1"
    ? { retries: 1, workers: 2, fullyParallel: true }
    : {}),
});
