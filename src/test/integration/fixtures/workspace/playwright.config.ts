import { defineConfig } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

const testDir = defineBddConfig({
  features: process.env["SPECWRIGHT_NATIVE_RETRY_OUTLINE"] === "1"
    ? "features/retry-outline.feature"
    : "features/**/*.feature",
  steps: ["features/steps/**/*.ts"],
});

export default defineConfig({
  testDir,
  reporter: "list",
  ...(process.env["SPECWRIGHT_NATIVE_RETRY_OUTLINE"] === "1"
    ? { retries: 1, workers: 2, fullyParallel: true }
    : {}),
});
