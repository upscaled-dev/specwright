import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { OUTLINE_ID_SEPARATOR } from "../../../test-providers/constants";
import { activatedTestProvider, waitUntil } from "./fixture-host";
import { openTestRunOutput, savedTestRuns, type SavedRun } from "./native-test-results";
import { connectProgressUi } from "./progress-ui";
import { shellQuote } from "../../../utils/shell";

const PROGRESS_ENV = "SPECWRIGHT_NATIVE_PROGRESS_ROOT";
const OUTLINE = "Native progress <row>";
const PAYMENT_OUTLINES = ["Pay by card", "Pay by cash"] as const;
const STAGES = ["preparing", "generating", "retry", "teardown", "finishing"] as const;

suite("observed native run progress", () => {
  test("testing and editor runs show observed stages and keep retry and teardown active", async () => {
    const provider = await activatedTestProvider();
    await vscode.commands.executeCommand("playwrightBddRunner.setFeatureBasedOrganization");
    await vscode.commands.executeCommand("playwrightBddRunner.discoverTests");
    const scenario = [...provider.testIdToScenarioMap.values()].find(
      (candidate) => candidate.isScenarioOutline && candidate.outlineName === OUTLINE
    );
    assert.ok(scenario?.isScenarioOutline);
    const feature = provider.getFeatureItem(scenario.filePath);
    const outline = feature?.children.get(
      `${scenario.filePath}${OUTLINE_ID_SEPARATOR}${scenario.outlineLineNumber}:${OUTLINE}`
    );
    assert.ok(outline);
    const paymentOutlines = PAYMENT_OUTLINES.map((name) => {
      const payment = [...provider.testIdToScenarioMap.values()].find(
        (candidate) => candidate.isScenarioOutline && candidate.outlineName === name
      );
      assert.ok(payment?.isScenarioOutline);
      const item = feature?.children.get(
        `${payment.filePath}${OUTLINE_ID_SEPARATOR}${payment.outlineLineNumber}:${name}`
      );
      assert.ok(item, `${name} must be in the native controller`);
      assert.equal(item.children.size, 1, `${name} must have one populated example`);
      return item;
    });
    assert.ok(feature);
    const profile = provider.registeredRunProfiles.find((candidate) => candidate.label === "Run");
    assert.ok(profile);
    const settings = vscode.workspace.getConfiguration("playwrightBddRunner");
    const previous = new Map(["playwrightCommand", "bddgenCommand", "preRunCommand", "useConfigReporters"].map(
      (key) => [key, settings.inspect<string | boolean>(key)?.workspaceValue]
    ));
    const previousEnv = process.env[PROGRESS_ENV];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-progress-"));
    const ui = await connectProgressUi();
    const token = new vscode.CancellationTokenSource();
    let active: Promise<unknown> | undefined;
    const releaseAll = (): void => {
      for (const stage of STAGES) {fs.writeFileSync(path.join(root, `release-${stage}`), "go");}
    };
    try {
      process.env[PROGRESS_ENV] = root;
      const command = path.join(path.dirname(scenario.filePath), "../progress-command.cjs");
      await settings.update("playwrightCommand", "npx playwright test", vscode.ConfigurationTarget.Workspace);
      await settings.update("useConfigReporters", true, vscode.ConfigurationTarget.Workspace);
      await settings.update("preRunCommand", `node ${shellQuote(command)} preparing`, vscode.ConfigurationTarget.Workspace);
      await settings.update("bddgenCommand", `node ${shellQuote(command)} generating`, vscode.ConfigurationTarget.Workspace);
      for (const entry of ["testing", "editor"] as const) {
        for (const file of fs.readdirSync(root)) {fs.unlinkSync(path.join(root, file));}
        const previousIds = new Set(savedTestRuns().map((run) => run.id));
        let ended = false;
        const execution = entry === "testing"
          ? Promise.resolve(profile.runHandler(new vscode.TestRunRequest([feature], undefined, profile), token.token))
          : Promise.resolve(vscode.commands.executeCommand("playwrightBddRunner.runFeatureFile", scenario.filePath));
        active = execution.finally(() => {ended = true;});
        // Attach immediately so a failed native run cannot become an unhandled rejection while a gate is awaited.
        void active.catch(() => undefined);
        const stages = [
          ["preparing", "Preparing run"],
          ["generating", "Generating tests"],
          ["retry", "Running 4/4, retrying tests"],
          ["teardown", "Running 4/4"],
          ["finishing", "Finishing run"],
        ] as const;
        for (const [stage, text] of stages) {
          await waitUntil(() => fs.existsSync(path.join(root, `${stage}-ready`)) || ended,
            30_000, `${entry} ${stage} gate`);
          if (ended) {
            let stopped: SavedRun | undefined;
            try {
              await waitUntil(() => {
                stopped = savedTestRuns().find((run) => !previousIds.has(run.id) && run.completedAt !== undefined);
                return stopped !== undefined;
              }, 15_000, `${entry} early completion output`);
              assert.ok(stopped);
              console.error(`${entry} run ended at ${stage}; observed gates: ${fs.readdirSync(root).join(", ")}\n` +
                (await openTestRunOutput(stopped.id)).getText());
            } catch (error) {
              console.error(`Could not read ${entry} run output after completion at ${stage}: ${String(error)}`);
            }
          }
          assert.equal(ended, false, `${entry} must remain open at ${stage}`);
          await ui?.expectStatus(text);
          if (entry === "editor") {await ui?.expectNotification(text);}
          fs.writeFileSync(path.join(root, `release-${stage}`), "go");
        }
        await active;
        active = undefined;
        let saved: SavedRun | undefined;
        await waitUntil(() => {
          saved = savedTestRuns().find((run) => !previousIds.has(run.id) && run.completedAt !== undefined
            && run.items?.some((item) => item.item.extId.endsWith(`\0${outline.id}`)));
          return saved !== undefined;
        }, 15_000, `${entry} populated native Test Results`);
        assert.ok(saved?.items);
        const rows: vscode.TestItem[] = [];
        for (const parent of [outline, ...paymentOutlines]) {parent.children.forEach((row) => rows.push(row));}
        assert.equal(rows.length, 4);
        for (const row of rows) {
          const result: NonNullable<SavedRun["items"]>[number] | undefined = saved.items.find(
            (item) => item.item.extId.endsWith(`\0${row.id}`)
          );
          assert.equal(result?.tasks[0]?.state, 3, `${entry} ${row.label} must finish green`);
        }
        await vscode.commands.executeCommand("testing.showMostRecentOutput");
        const output = (await openTestRunOutput(saved.id)).getText();
        const evidence = path.resolve(__dirname, "../../../../.local");
        fs.mkdirSync(evidence, { recursive: true });
        fs.writeFileSync(path.join(evidence, `native-progress-${entry}-output.log`), output);
        for (const [, text] of stages) {assert.ok(output.includes(text), `${entry} output must show ${text}`);}
        assert.ok(output.includes("Retrying Native progress retry, attempt 2"));
        assert.ok(output.includes("Finishing run"), "explicit reporter end must reach native Test Results");
        assert.ok(output.indexOf("Finishing run") > output.indexOf("Retrying Native progress retry"));
        const clean = output.split(/\r?\n/).find((line) => line.includes("✔") && line.includes("Native progress clean"));
        const retry = output.split(/\r?\n/).find((line) => line.includes("✔") && line.includes("Native progress retry"));
        assert.ok(clean && !clean.includes("Passed on attempt"), `${entry} clean summary: ${clean}`);
        assert.ok(retry?.includes("Passed on attempt 2"), `${entry} retry summary: ${retry}`);
        for (const name of PAYMENT_OUTLINES) {
          assert.ok(output.includes(`Retrying ${name} (Example #1), attempt 2`),
            `${entry} must identify the retry's enclosing outline ${name}`);
          const summary = output.split(/\r?\n/).find(
            (line) => line.startsWith(`✔ Scenario Outline: ${name} (Example #1)`)
          );
          assert.ok(summary?.includes("Passed on attempt 2"), `${entry} ${name} summary: ${summary}`);
        }
        assert.ok(!output.includes("Retrying Example #1,"), `${entry} generic retry titles must include their outline`);
      }
    } finally {
      token.cancel();
      releaseAll();
      await active?.catch(() => undefined);
      token.dispose();
      for (const [key, value] of previous) {await settings.update(key, value, vscode.ConfigurationTarget.Workspace);}
      if (previousEnv === undefined) {delete process.env[PROGRESS_ENV];}
      else {process.env[PROGRESS_ENV] = previousEnv;}
      await ui?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
