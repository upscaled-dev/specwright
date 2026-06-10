import { describe, it, expect, vi } from "vitest";
import { CommandBuilder } from "../../core/command-builder";
import type { Logger } from "../../utils/logger";

function loggerStub(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

interface ConfigStub {
  playwrightCommand: string;
  bddgenCommand: string;
  tags: string;
  reporter: string;
  parallelExecution: boolean;
  maxParallelProcesses: number;
  dryRun: boolean;
  workingDirectory: string;
}

function makeConfig(overrides: Partial<ConfigStub> = {}): ConfigStub {
  return {
    playwrightCommand: "npx playwright test",
    bddgenCommand: "npx bddgen",
    tags: "",
    reporter: "list",
    parallelExecution: false,
    maxParallelProcesses: 4,
    dryRun: false,
    workingDirectory: "",
    ...overrides,
  };
}

describe("CommandBuilder", () => {
  it("chains bddgen and playwright test for a scenario, --grep'd by name", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildScenarioCommand({
      filePath: "/abs/features/a.feature",
      scenarioName: "Passing scenario",
    });
    expect(cmd).toMatch(/^npx bddgen && npx playwright test/);
    expect(cmd).toContain('--grep "Passing scenario"');
  });

  it("greps by outlineName verbatim when provided via TestExecutionOptions", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildScenarioCommand({
      filePath: "/abs/features/a.feature",
      scenarioName: "1: Test outline - input: hello, expected: world",
      outlineName: "Test outline",
    });
    expect(cmd).toContain('--grep "Test outline"');
  });

  it("greps by outlineName verbatim when the name itself contains ' - '", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildScenarioCommand({
      filePath: "/abs/features/a.feature",
      scenarioName: "1: Login - Happy Path - name: Alice - Smith",
      outlineName: "Login - Happy Path",
    });
    expect(cmd).toContain('--grep "Login - Happy Path"');
    expect(cmd).not.toContain('--grep "Login"');
  });

  it("greps by outlineName when only outlineName is provided (whole-outline run)", async () => {
    // The Test Explorer's Scenario Outline node runs with outlineName but no scenarioName.
    // Without a --grep here Playwright would run the ENTIRE suite (the "16 passed" bug).
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildScenarioCommand({
      filePath: "/abs/features/a.feature",
      outlineName: "Feature-level outline for totals",
    });
    expect(cmd).toContain('--grep "Feature-level outline for totals"');
  });

  it("greps by scenarioName when outlineName is undefined (non-outline scenario)", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildScenarioCommand({
      filePath: "/abs/features/a.feature",
      scenarioName: "Some plain scenario",
    });
    expect(cmd).toContain('--grep "Some plain scenario"');
  });

  it("passes --tags to bddgen", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildTagCommand("@smoke and not @wip");
    expect(cmd).toContain('npx bddgen --tags "@smoke and not @wip"');
  });

  it("omits bddgen when bddgenCommand is empty", async () => {
    const builder = CommandBuilder.create(makeConfig({ bddgenCommand: "" }) as never, loggerStub());
    const cmd = await builder.buildAllTestsCommand();
    expect(cmd).not.toContain("bddgen");
    expect(cmd).toMatch(/^npx playwright test/);
  });

  it("adds --workers when parallel execution is enabled", async () => {
    const builder = CommandBuilder.create(
      makeConfig({ parallelExecution: true, maxParallelProcesses: 6 }) as never,
      loggerStub()
    );
    const cmd = await builder.buildAllTestsCommand();
    expect(cmd).toContain("--workers=6");
  });

  it("uses --list for dry run", async () => {
    const builder = CommandBuilder.create(makeConfig({ dryRun: true }) as never, loggerStub());
    const cmd = await builder.buildAllTestsCommand();
    expect(cmd).toContain("--list");
  });

  it("splits debug into a bddgen half and a playwright half grepped without the Inspector --debug flag", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const { bddgenCommand, playwrightCommand } = builder.buildDebugCommandParts({
      filePath: "/abs/features/a.feature",
      scenarioName: "Passing",
    });
    expect(bddgenCommand).toBe("npx bddgen");
    // The Playwright Inspector flag must NOT be present — debugging runs under VS Code's
    // JS debugger (node-terminal), not the Inspector.
    expect(playwrightCommand).not.toContain("--debug");
    expect(playwrightCommand).not.toContain("bddgen");
    expect(playwrightCommand).toContain('--grep "Passing"');
  });

  it("carries --tags on the bddgen half of the debug command", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const { bddgenCommand, playwrightCommand } = builder.buildDebugCommandParts({
      filePath: "/abs/features/a.feature",
      scenarioName: "Passing",
      tags: "@smoke and not @wip",
    });
    expect(bddgenCommand).toBe('npx bddgen --tags "@smoke and not @wip"');
    expect(playwrightCommand).not.toContain("--tags");
  });

  it("yields bddgenCommand undefined for debug when bddgenCommand config is empty", () => {
    const builder = CommandBuilder.create(makeConfig({ bddgenCommand: "" }) as never, loggerStub());
    const { bddgenCommand, playwrightCommand } = builder.buildDebugCommandParts({
      filePath: "/abs/features/a.feature",
      scenarioName: "Passing",
    });
    expect(bddgenCommand).toBeUndefined();
    expect(playwrightCommand).toMatch(/^npx playwright test/);
  });

  it("greps the feature basename when no scenario is targeted for debug", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const { playwrightCommand } = builder.buildDebugCommandParts({
      filePath: "/abs/features/login.feature",
    });
    expect(playwrightCommand).not.toContain("--debug");
    expect(playwrightCommand).toContain('--grep "login"');
  });

  it("filters by feature-file basename for a feature run when no title is known", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildFeatureCommand({ filePath: "/abs/features/login.feature" });
    expect(cmd).toContain('--grep "login"');
  });

  it("greps by the Feature title when provided (not the filename, which matched other features)", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildFeatureCommand({
      filePath: "/abs/fixtures/sample.feature",
      featureName: "Fixture feature",
    });
    expect(cmd).toContain('--grep "Fixture feature"');
    expect(cmd).not.toContain('--grep "sample"');
  });

  it("adds --workers when setForceParallel(true) is set, even if parallelExecution=false", async () => {
    const builder = CommandBuilder.create(
      makeConfig({ parallelExecution: false, maxParallelProcesses: 3 }) as never,
      loggerStub()
    );
    builder.setForceParallel(true);
    const cmd = await builder.buildAllTestsCommand();
    expect(cmd).toContain("--workers=3");
  });

  it("omits --workers after setForceParallel(false) is set", async () => {
    const builder = CommandBuilder.create(
      makeConfig({ parallelExecution: false, maxParallelProcesses: 3 }) as never,
      loggerStub()
    );
    builder.setForceParallel(true);
    builder.setForceParallel(false);
    const cmd = await builder.buildAllTestsCommand();
    expect(cmd).not.toContain("--workers");
  });
});
