import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
  media: { markdown?: string; image?: string; svg?: string };
  completionEvents?: string[];
}

interface PackageJson {
  contributes: {
    commands: Array<{ command: string }>;
    colors?: Array<{ id: string; description: string; defaults: Record<string, string> }>;
    walkthroughs?: Array<{ id: string; title: string; steps: WalkthroughStep[] }>;
    menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
  };
}

const repoRoot = path.resolve(__dirname, "../../..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as PackageJson;

describe("contributes.walkthroughs: Set up Xray", () => {
  const walkthrough = pkg.contributes.walkthroughs?.find((w) => w.id === "specwright.setupXray");

  it("contributes the five §4.4 steps in order", () => {
    expect(walkthrough?.title).toBe("Set up Xray");
    expect(walkthrough?.steps.map((s) => s.id)).toEqual([
      "specwright.setupXray.site",
      "specwright.setupXray.apiKey",
      "specwright.setupXray.credentials",
      "specwright.setupXray.jira",
      "specwright.setupXray.sync",
    ]);
  });

  it("ships every step's markdown media inside the package", () => {
    for (const step of walkthrough!.steps) {
      const markdown = step.media.markdown;
      expect(markdown, `${step.id} should use markdown media`).toBeDefined();
      // media/** is not in .vscodeignore, so these files ship in the vsix.
      expect(markdown!.startsWith("media/")).toBe(true);
      expect(fs.existsSync(path.join(repoRoot, markdown!)), `${markdown} must exist`).toBe(true);
    }
  });

  it("drives each step from an existing contributed command", () => {
    const commandIds = new Set(pkg.contributes.commands.map((c) => c.command));
    const linked = (description: string): string[] =>
      [...description.matchAll(/command:([\w.]+)/g)].map((m) => m[1]!);
    for (const step of walkthrough!.steps) {
      for (const cmd of linked(step.description)) {
        expect(commandIds.has(cmd), `${step.id} links unknown command ${cmd}`).toBe(true);
      }
    }
    // Steps 1–4 open the setup webview via connect; the last step runs Sync.
    expect(walkthrough!.steps.at(-1)!.description).toContain("command:playwrightBddRunner.traceability.sync");
    for (const step of walkthrough!.steps.slice(0, 4)) {
      expect(step.description).toContain("command:playwrightBddRunner.traceability.connect");
    }
  });
});

describe("contributes.colors: tag-line decoration", () => {
  it("contributes a theme-aware faint wash color for the traceability tag decoration", () => {
    const color = pkg.contributes.colors?.find((c) => c.id === "specwright.traceabilityTagBackground");
    expect(color).toBeDefined();
    expect(color!.defaults).toHaveProperty("dark");
    expect(color!.defaults).toHaveProperty("light");
  });
});

describe("view/item/context: orphan row commands", () => {
  it("places open-issue and copy-key on the orphan row, reusing the shared commands", () => {
    const itemContext = pkg.contributes.menus["view/item/context"]!;
    const orphan = itemContext.filter((e) => e.when?.includes("traceabilityOrphan"));
    expect(orphan.map((e) => e.command)).toEqual([
      "playwrightBddRunner.traceability.openIssue",
      "playwrightBddRunner.traceability.copyKey",
    ]);
    for (const entry of orphan) {
      expect(entry.when).toBe("view == playwrightBddRunner.traceability && viewItem == traceabilityOrphan");
    }
  });
});
