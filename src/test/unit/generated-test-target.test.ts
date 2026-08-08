import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  exactGeneratedTargets,
  needsGeneratedSpecs,
} from "../../core/generated-test-target";

describe("generated test targets", () => {
  let root: string;
  let feature: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "generated-target-"));
    feature = path.join(root, "features/a.feature");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeProject(project: string, pwTestLine: number): void {
    const spec = path.join(root, ".features-gen", project, "features/a.feature.spec.js");
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, [
      "// Generated from: features/a.feature",
      "const bddFileData = [ // bdd-data-start",
      `  {"pwTestLine":${pwTestLine},"pickleLine":7,"steps":[]},`,
      "]; // bdd-data-end",
    ].join("\n"));
  }

  it("resolves an exact target for every generated BDD project", () => {
    const unnamed = path.join(root, ".features-gen", "features/a.feature.spec.js");
    const browser = path.join(root, ".features-gen", "browser/a.feature.spec.js");
    fs.mkdirSync(path.dirname(unnamed), { recursive: true });
    fs.mkdirSync(path.dirname(browser), { recursive: true });
    fs.writeFileSync(unnamed, [
      "// Generated from: features/a.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":11,"pickleLine":7,"steps":[]},',
      "]; // bdd-data-end",
    ].join("\n"));
    fs.writeFileSync(browser, [
      "// Generated from: features/a.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":17,"pickleLine":7,"steps":[]},',
      "]; // bdd-data-end",
    ].join("\n"));

    expect(exactGeneratedTargets(root, ".features-gen", feature, 7)).toEqual({
      targets: [
        ".features-gen/features/a.feature.spec.js:11",
        ".features-gen/browser/a.feature.spec.js:17",
      ],
    });
  });

  it("requires current generated specs for a missing or stale exact map", () => {
    expect(needsGeneratedSpecs(
      root,
      ".features-gen",
      feature,
      7,
      undefined,
      "A",
      false
    )).toBe(true);
    writeProject("browser", 17);
    expect(needsGeneratedSpecs(
      root,
      ".features-gen",
      feature,
      8,
      undefined,
      "A",
      false
    )).toBe(true);
  });

  it("never turns a line-less plain scenario into a generated-spec requirement and name grep", () => {
    expect(needsGeneratedSpecs(
      root,
      ".features-gen",
      feature,
      0,
      undefined,
      "A",
      false
    )).toBe(false);
  });

  it("rejects a same-basename spec that declares a different source feature", () => {
    const spec = path.join(root, ".features-gen/a.feature.spec.js");
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, [
      "// Generated from: other/a.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":11,"pickleLine":7,"steps":[]},',
      "]; // bdd-data-end",
    ].join("\n"));

    expect(exactGeneratedTargets(root, ".features-gen", feature, 7)).toEqual({
      reason: expect.stringContaining(`no generated spec belongs to ${feature}`),
    });
  });

  it("pins every matching project and ignores a foreign same-basename candidate", () => {
    const foreign = path.join(root, ".features-gen/a.feature.spec.js");
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, [
      "// Generated from: other/a.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":5,"pickleLine":7,"steps":[]},',
      "]; // bdd-data-end",
    ].join("\n"));
    writeProject("browser", 17);
    writeProject("mobile", 23);

    expect(exactGeneratedTargets(root, ".features-gen", feature, 7)).toEqual({
      targets: [
        ".features-gen/browser/features/a.feature.spec.js:17",
        ".features-gen/mobile/features/a.feature.spec.js:23",
      ],
    });
  });

  it("rejects a generated spec with no source identity", () => {
    writeProject("browser", 17);
    const spec = path.join(root, ".features-gen/browser/features/a.feature.spec.js");
    fs.writeFileSync(spec, fs.readFileSync(spec, "utf8").replace(/^.*\n/, ""));
    writeProject("mobile", 23);

    expect(exactGeneratedTargets(root, ".features-gen", feature, 7)).toEqual({
      reason: expect.stringContaining('has no "Generated from" source identity'),
    });
  });
});
