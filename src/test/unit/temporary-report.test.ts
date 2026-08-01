import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TemporaryReport } from "../../core/temporary-report";

describe("TemporaryReport", () => {
  const leftovers: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of leftovers.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function create(
    onCleanupError: (error: Error) => void = () => undefined,
    removeDirectory?: (directory: string) => void
  ): TemporaryReport {
    const report = TemporaryReport.create(onCleanupError, removeDirectory);
    leftovers.push(path.dirname(report.jsonPath));
    return report;
  }

  it("owns final and live files inside one unique temporary directory", () => {
    const first = create();
    const second = create();

    expect(path.dirname(first.jsonPath)).toBe(path.dirname(first.livePath));
    expect(path.dirname(first.jsonPath)).not.toBe(path.dirname(second.jsonPath));
    expect(fs.existsSync(path.dirname(first.jsonPath))).toBe(true);
  });

  it("removes written reports and their directory", () => {
    const report = create();
    const directory = path.dirname(report.jsonPath);
    fs.writeFileSync(report.jsonPath, "{}");
    fs.writeFileSync(report.livePath, "");

    report.dispose();

    expect(fs.existsSync(directory)).toBe(false);
  });

  it("disposes once when files are missing or disposal is repeated", () => {
    const remove = vi.fn((directory: string) => {
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const report = create(() => undefined, remove);

    report.dispose();
    report.dispose();

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(path.dirname(report.jsonPath));
  });

  it("reports cleanup failure without throwing or retrying disposal", () => {
    const failure = new Error("locked");
    const observed: Error[] = [];
    const remove = vi.fn(() => { throw failure; });
    const report = create((error) => {
      observed.push(error);
      throw new Error("observer failed");
    }, remove);

    expect(() => report.dispose()).not.toThrow();
    expect(() => report.dispose()).not.toThrow();

    expect(observed).toEqual([failure]);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("prevents a late writer from recreating a report after disposal", () => {
    const report = create();
    report.dispose();

    expect(() => fs.writeFileSync(report.jsonPath, "{}"))
      .toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});
