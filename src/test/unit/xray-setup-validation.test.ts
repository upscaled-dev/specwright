import { describe, expect, it } from "vitest";
import { validateXraySetupInput } from "../../xray/xray-setup-validation";

describe("validateXraySetupInput", () => {
  it("rejects hosts that normalize to empty or are not a bare host", () => {
    expect(validateXraySetupInput("https://", "id", "secret")?.site).toBeTruthy();
    expect(validateXraySetupInput("   ", "id", "secret")?.site).toBeTruthy();
    expect(validateXraySetupInput("acme.atlassian.net/jira", "id", "secret")?.site).toBeTruthy();
    expect(validateXraySetupInput("acme.atlassian.net:8080", "id", "secret")?.site).toBeTruthy();
  });

  it("accepts bare hosts and full URLs", () => {
    expect(validateXraySetupInput("acme.atlassian.net", "id", "secret")).toBeUndefined();
    expect(validateXraySetupInput("https://acme.atlassian.net/", "id", "secret")).toBeUndefined();
  });

  it("requires a non-empty client id and secret", () => {
    expect(validateXraySetupInput("acme.atlassian.net", "  ", "secret")?.clientId).toBeTruthy();
    expect(validateXraySetupInput("acme.atlassian.net", "id", "  ")?.clientSecret).toBeTruthy();
  });
});
