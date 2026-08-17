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

  it("merges setup into three steps with real save completion", () => {
    expect(walkthrough?.title).toBe("Set up Xray");
    expect(walkthrough?.steps.map((s) => s.id)).toEqual([
      "specwright.setupXray.site",
      "specwright.setupXray.credentials",
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
    // Opening setup, saving setup, and syncing are distinct user outcomes.
    expect(walkthrough!.steps[0]!.description).toContain("command:playwrightBddRunner.traceability.connect");
    expect(walkthrough!.steps[1]!.completionEvents).toEqual([
      "onCommand:playwrightBddRunner.traceability.setupSaved",
    ]);
    expect(walkthrough!.steps.at(-1)!.description).toContain("command:playwrightBddRunner.traceability.sync");
  });

  it("uses fictional site data and names every form region", () => {
    expect(walkthrough!.steps[0]!.description).toContain("acme.atlassian.net");
    expect(walkthrough!.steps[0]!.description).toContain("Global, US, EU, or AU");
  });
});

describe("contributes.walkthroughs: core BDD workflow", () => {
  const walkthrough = pkg.contributes.walkthroughs?.find((w) => w.id === "specwright.coreWorkflow");

  it("contributes the five core steps in order", () => {
    expect(walkthrough?.steps.map(({ id }) => id)).toEqual([
      "specwright.coreWorkflow.diagnose",
      "specwright.coreWorkflow.testing",
      "specwright.coreWorkflow.run",
      "specwright.coreWorkflow.stepDefinition",
      "specwright.coreWorkflow.steps",
    ]);
  });

  it("uses a real contributed command for every action and completion event", () => {
    const commands = new Set(pkg.contributes.commands.map(({ command }) => command));
    for (const step of walkthrough!.steps) {
      const linked = [...step.description.matchAll(/command:([\w.]+)/g)].map((match) => match[1]!);
      expect(linked.length).toBeGreaterThan(0);
      expect(linked.every((command) => commands.has(command))).toBe(true);
      expect(step.completionEvents?.length).toBeGreaterThan(0);
      expect(step.completionEvents?.every((event) =>
        commands.has(event.replace("onCommand:", ""))
      )).toBe(true);
    }
  });
});

describe("walkthrough completion isolation", () => {
  it("never shares a completion event between steps", () => {
    const owners = new Map<string, string>();
    for (const walkthrough of pkg.contributes.walkthroughs ?? []) {
      for (const step of walkthrough.steps) {
        for (const event of step.completionEvents ?? []) {
          expect(owners.get(event), `${event} is shared by ${owners.get(event)} and ${step.id}`)
            .toBeUndefined();
          owners.set(event, step.id);
        }
      }
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
  it("moves orphan actions into the traceability webview", () => {
    const itemContext = pkg.contributes.menus["view/item/context"]!;
    const orphan = itemContext.filter((e) => e.when?.includes("traceabilityOrphan"));
    expect(orphan).toEqual([]);
  });
});
