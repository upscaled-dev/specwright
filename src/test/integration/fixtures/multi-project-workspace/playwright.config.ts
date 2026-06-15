import { defineConfig } from "@playwright/test";
import { defineBddProject } from "playwright-bdd";

/**
 * Multi-project fixture. API and UI features live in separate folders, each owned by its own
 * playwright-bdd project via `defineBddProject`. Used to develop and verify project
 * auto-detection: mapping a source `.feature` file back to the Playwright `--project` it
 * belongs to (the case where a single workspace root holds several separated BDD projects).
 *
 * `defineBddProject` returns `{ name, testDir }`; each project's generated specs land under a
 * distinct `testDir`, so the generated spec path encodes which project a feature belongs to.
 */
const api = defineBddProject({
  name: "api",
  features: "api/features/**/*.feature",
  steps: ["api/steps/**/*.ts"],
});

const ui = defineBddProject({
  name: "ui",
  features: "ui/features/**/*.feature",
  steps: ["ui/steps/**/*.ts"],
});

export default defineConfig({
  reporter: "list",
  projects: [api, ui],
});
