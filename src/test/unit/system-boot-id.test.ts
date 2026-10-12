import { describe, expect, it, vi } from "vitest";
import { isCanonicalBootId, resolveSystemBootId } from "../../core/system-boot-id";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFileSync: vi.fn(),
}));

const LINUX_BOOT = "linux:12345678-1234-1234-1234-123456789abc";
const DARWIN_BOOT = "darwin:abcdef01-2345-6789-abcd-ef0123456789";
const BOOT_EVENT = "<Events><Event><System>" +
  "<Provider Name='Microsoft-Windows-Kernel-General'/><EventID>12</EventID>" +
  "<EventRecordID>4182</EventRecordID></System></Event></Events>";

describe("system boot identity", () => {
  it("contains empty and failed native command output without estimating a boot id", () => {
    const run = vi.mocked(childProcess.execFileSync).mockReturnValueOnce(" ")
      .mockImplementationOnce(() => {throw new Error("sysctl unavailable");});
    try {
      expect(resolveSystemBootId("darwin")).toBeUndefined();
      expect(resolveSystemBootId("darwin")).toBeUndefined();
      expect(run).toHaveBeenCalledWith("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], expect.objectContaining({ timeout: 1500 }));
    } finally {run.mockReset();}
  });

  it.each(["linux", "darwin"] as const)("rejects missing or invalid %s boot UUIDs", platform => {
    expect(resolveSystemBootId(platform, () => undefined, () => undefined)).toBeUndefined();
    expect(resolveSystemBootId(platform, () => "invalid", () => "invalid")).toBeUndefined();
  });

  it("leaves an unsupported operating system without a fabricated identity", () => {
    const run = vi.fn();
    expect(resolveSystemBootId("freebsd", () => undefined, run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
  it("recognizes only canonical producer-owned identity shapes", () => {
    expect([LINUX_BOOT, DARWIN_BOOT, "win32:4182", "win32:18446744073709551615"]
      .every(isCanonicalBootId)).toBe(true);
    expect(["linux:anything", "darwin: ABC", "win32:0", "win32:18446744073709551616"]
      .some(isCanonicalBootId)).toBe(false);
  });

  it("normalizes Linux and Darwin producer UUIDs", () => {
    expect(resolveSystemBootId("linux", () => "12345678-1234-1234-1234-123456789ABC\n"))
      .toBe(LINUX_BOOT);
    expect(resolveSystemBootId("darwin", () => undefined, () => "ABCDEF01-2345-6789-ABCD-EF0123456789\n"))
      .toBe(DARWIN_BOOT);
  });

  it("queries the newest Windows kernel boot event without timestamps", () => {
    const run = vi.fn(() => BOOT_EVENT);
    expect(resolveSystemBootId("win32", () => undefined, run)).toBe("win32:4182");
    expect(run).toHaveBeenCalledWith("wevtutil.exe", ["qe", "System",
      "/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and EventID=12]]",
      "/rd:true", "/f:xml", "/c:1"]);
  });

  it.each([undefined, "<Events></Events>", BOOT_EVENT.replace("EventID>12", "EventID>13"),
    BOOT_EVENT.replace("Kernel-General", "Kernel-Power"), BOOT_EVENT.replace("4182", "0"),
    BOOT_EVENT.replace("4182", "18446744073709551616"),
    BOOT_EVENT.replace("</System>", "<EventRecordID>4183</EventRecordID></System>")])(
    "has no identity for absent or malformed boot output: %s", (output) => {
      expect(resolveSystemBootId("win32", () => undefined, () => output)).toBeUndefined();
    }
  );
});
