import { describe, it, expect, vi } from "vitest";
import { CommandBuilder } from "../../core/command-builder";
import type { Logger } from "../../utils/logger";
import type { TestExecutionOptions } from "../../types";

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
  useConfigReporters: boolean;
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
    useConfigReporters: false,
    parallelExecution: false,
    maxParallelProcesses: 4,
    dryRun: false,
    workingDirectory: "",
    ...overrides,
  };
}

// Extract the --grep regex from a built command, reversing posixQuote (tests run on posix) so the
// pattern can be exercised against realistic Playwright grep targets.
function grepRegexOf(cmd: string): RegExp {
  const quoted = /--grep "(.*)" --reporter/.exec(cmd)?.[1] ?? "";
  const raw = quoted
    .replaceAll('\\"', '"')
    .replaceAll("\\`", "`")
    .replaceAll("\\$", "$")
    .replaceAll("\\\\", "\\");
  return new RegExp(raw);
}

// The executor runs the two halves in sequence; joining them is how the built command reads.
function scenarioCommand(builder: CommandBuilder, options: TestExecutionOptions): string {
  const { bddgenCommand, playwrightCommand } = builder.buildScenarioCommandParts(options);
  return bddgenCommand ? `${bddgenCommand} && ${playwrightCommand}` : playwrightCommand;
}

describe("CommandBuilder", () => {
  it("chains bddgen and playwright test for a scenario, --grep'd by name", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = scenarioCommand(builder, {
      filePath: "/abs/features/a.feature",
      scenarioName: "Passing scenario",
    });
    expect(cmd).toMatch(/^npx bddgen && npx playwright test/);
    expect(cmd).toContain('--grep "Passing scenario"');
  });

  it("greps by outlineName verbatim when provided via TestExecutionOptions", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = scenarioCommand(builder, {
      filePath: "/abs/features/a.feature",
      scenarioName: "1: Test outline - input: hello, expected: world",
      outlineName: "Test outline",
    });
    expect(cmd).toContain('--grep "Test outline"');
  });

  it("greps by outlineName verbatim when the name itself contains ' - '", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = scenarioCommand(builder, {
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
    const cmd = scenarioCommand(builder, {
      filePath: "/abs/features/a.feature",
      outlineName: "Feature-level outline for totals",
    });
    expect(cmd).toContain('--grep "Feature-level outline for totals"');
  });

  it("greps by scenarioName when outlineName is undefined (non-outline scenario)", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = scenarioCommand(builder, {
      filePath: "/abs/features/a.feature",
      scenarioName: "Some plain scenario",
    });
    expect(cmd).toContain('--grep "Some plain scenario"');
  });

  it("wildcards <placeholders> in an outline title so the grep matches expanded example titles", async () => {
    // playwright-bdd substitutes placeholders in the generated test titles ("<role>" -> "admin"),
    // so a literal `<role>` grep only matched the parent describe; `< >` are also cmd.exe/PowerShell
    // redirection operators, which broke the run on Windows ("cannot find the tests").
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = scenarioCommand(builder, {
      filePath: "/abs/features/login.feature",
      outlineName: "Login as <role> with <plan> plan",
    });
    expect(cmd).toContain('--grep "Login as .* with .* plan"');
    // No shell-hostile angle brackets survive into the command.
    expect(cmd).not.toContain("<");
    expect(cmd).not.toContain(">");
    // The wildcarded pattern matches playwright-bdd's expanded example title.
    const grep = /--grep "([^"]*)"/.exec(cmd)?.[1] ?? "";
    expect(new RegExp(grep).test("Login as admin with pro plan")).toBe(true);
  });

  it("prefers a specLineTarget over --grep for a scenario run (precise single-row targeting)", async () => {
    // Grep on an outline title can't isolate one example row; playwright-bdd substitutes the
    // example values into the title, so a resolved `<spec>:<pwTestLine>` target wins instead.
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = scenarioCommand(builder, {
      filePath: "/abs/features/products.feature",
      scenarioName: "1: Create a product (<name>) - name: Widget",
      outlineName: "Create a product (<name>)",
      lineNumber: 10,
      specLineTargets: [".features-gen/features/products.feature.spec.js:8"],
    });
    expect(cmd).toContain('npx playwright test ".features-gen/features/products.feature.spec.js:8"');
    expect(cmd).not.toContain("--grep");
  });

  it("runs every exact generated-project target in one invocation", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const command = builder.buildScenarioCommandParts({
      filePath: "/work/features/products.feature",
      scenarioName: "buy",
      specLineTargets: [
        ".features-gen/api/features/products.feature.spec.js:8",
        ".features-gen/browser/features/products.feature.spec.js:12",
      ],
    }).playwrightCommand;

    expect(command).toContain(".features-gen/api/features/products.feature.spec.js:8");
    expect(command).toContain(".features-gen/browser/features/products.feature.spec.js:12");
    expect(command).not.toContain("--grep");
  });

  it("prefers a specLineTarget over --grep on the debug playwright half", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const { playwrightCommand } = builder.buildDebugCommandParts({
      filePath: "/abs/features/products.feature",
      scenarioName: "1: Create a product (<name>) - name: Widget",
      outlineName: "Create a product (<name>)",
      lineNumber: 10,
      specLineTargets: [".features-gen/features/products.feature.spec.js:8"],
    });
    expect(playwrightCommand).toContain('".features-gen/features/products.feature.spec.js:8"');
    expect(playwrightCommand).not.toContain("--grep");
  });

  it("falls back to name --grep when no specLineTarget is resolved", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = scenarioCommand(builder, {
      filePath: "/abs/features/products.feature",
      outlineName: "Create a product (<name>)",
      lineNumber: 10,
    });
    expect(cmd).toContain("--grep");
    expect(cmd).toContain("Create a product");
    expect(cmd).not.toContain(".spec.js:");
  });

  it("omits the injected --reporter when useConfigReporters is set, so config reporters survive", async () => {
    const builder = CommandBuilder.create(makeConfig({ useConfigReporters: true }) as never, loggerStub());
    const cmd = await builder.buildAllTestsCommand();
    expect(cmd).not.toContain("--reporter");
  });

  it("still injects --reporter when useConfigReporters is off (default)", async () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = await builder.buildAllTestsCommand();
    expect(cmd).toContain("--reporter=list");
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

  it("skips bddgen on every route when bddgenCommand is empty, tag expression or not", () => {
    const builder = CommandBuilder.create(makeConfig({ bddgenCommand: "" }) as never, loggerStub());
    const expression = "@smoke and not (@wip or @slow)";

    expect(builder.buildTagCommand(expression)).toMatch(/^npx playwright test/);
    expect(builder.buildPathFilterCommand("features/a\\.feature", expression))
      .not.toContain("bddgen");
    expect(builder.buildScenarioCommandParts({
      filePath: "/abs/features/a.feature",
      scenarioName: "A",
      tags: expression,
    }).bddgenCommand).toBeUndefined();
    expect(builder.buildDebugCommandParts({
      filePath: "/abs/features/a.feature",
      scenarioName: "A",
      tags: expression,
    }).bddgenCommand).toBeUndefined();
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
    // The Playwright Inspector flag must NOT be present; debugging runs under VS Code's
    // VS Code's JS debugger, not the Inspector.
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

  it("adds the json reporter alongside the configured one on the debug playwright half when jsonReportPath is set", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const { playwrightCommand } = builder.buildDebugCommandParts({
      filePath: "/abs/features/a.feature",
      scenarioName: "Passing",
      jsonReportPath: "/tmp/report.json",
    });
    expect(playwrightCommand).toContain("--reporter=list,json");
  });

  it("emits no reporter flag on the debug playwright half when jsonReportPath is unset", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const { playwrightCommand } = builder.buildDebugCommandParts({
      filePath: "/abs/features/a.feature",
      scenarioName: "Passing",
    });
    expect(playwrightCommand).not.toContain("--reporter");
  });

  it("pins a feature-level debug to its generated spec, never a basename grep", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const { playwrightCommand } = builder.buildDebugCommandParts({
      filePath: "/abs/features/login.feature",
      specFileFilters: ["\\.features-gen/features/login\\.feature\\.spec\\.js(?=[./]|$)"],
    });
    expect(playwrightCommand).not.toContain("--debug");
    expect(playwrightCommand).not.toContain("--grep");
    expect(playwrightCommand).toContain(".features-gen/features/login");
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

  it("passes a positional path filter through bddgen + playwright, not a --grep", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    // The batch scope pre-escapes the filter (forward slashes + regex metacharacters); the builder
    // just quotes it as a positional argument (shell-quoting doubles the backslash for the shell).
    const cmd = builder.buildPathFilterCommand("features/login\\.feature");
    expect(cmd).toMatch(/^npx bddgen && npx playwright test "features\/login/);
    expect(cmd).not.toContain("--grep");
  });

  it("keeps a path filter and tag expression in the same generated run", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = builder.buildPathFilterCommand(
      "features/login\\.feature",
      "@smoke and not @wip"
    );
    expect(cmd).toContain('npx bddgen --tags "@smoke and not @wip"');
    expect(cmd).toContain('npx playwright test "features/login');
    expect(cmd).not.toContain("--grep");
  });

  it("scopes several titles of one file to its positional filter and one escaped --grep", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const cmd = builder.buildPathFilterCommand(
      "features/cart\\.feature",
      undefined,
      ["Add to cart", "Checkout (guest)"]
    );
    expect(cmd).toMatch(/^npx bddgen && npx playwright test "features\/cart/);
    // Behavioral proof: reconstruct the regex from the (posix-shell-quoted) --grep argument and run
    // it against a realistic grep target, which Playwright joins with spaces as
    // `<spec path> <describes> <title> <tags>`.
    const regex = grepRegexOf(cmd);
    expect(regex.test("features/cart.feature.spec.js Cart Add to cart @TEST_APEX-1")).toBe(true);
    expect(regex.test("features/cart.feature.spec.js Cart Checkout (guest) @TEST_APEX-2")).toBe(true);
    expect(regex.test("features/cart.feature.spec.js Cart Add to cart")).toBe(true);
    expect(regex.test("features/cart.feature.spec.js Cart Refund order @TEST_APEX-3")).toBe(false);
    // The parens in the second name are regex-escaped, so they match literal parentheses.
    expect(regex.source).toContain("Checkout \\(guest\\)");
  });

  // A titled path target greps by title inside its file, so an unanchored pattern would run every
  // scenario whose title merely contains a selected one, publishing results for tests nobody selected.
  it("anchors each titled path-filter --grep so a longer title is not swept in", () => {
    const builder = CommandBuilder.create(makeConfig() as never, loggerStub());
    const regex = grepRegexOf(
      builder.buildPathFilterCommand("features/cart\\.feature", undefined, ["Add to cart"])
    );

    expect(regex.test("features/cart.feature.spec.js Cart Add to cart @TEST_APEX-1")).toBe(true);
    expect(regex.test("features/cart.feature.spec.js Cart Add to cart twice @TEST_APEX-2")).toBe(false);
    expect(regex.test("features/cart.feature.spec.js Cart Add to cartons")).toBe(false);
    expect(regex.test("features/cart.feature.spec.js Cart Add to cart later @slow")).toBe(false);
  });
});
