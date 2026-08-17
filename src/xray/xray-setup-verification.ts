import { errMsg, maskValues, serverText } from "../utils/text";
import {
  XRAY_SETUP_MASK,
  type SetupHostMessage,
} from "../webview/setup-protocol";
import type { XrayConnectionOutcome } from "./xray-connection-test";

type ProjectView = Extract<SetupHostMessage, { type: "project-view" }>;

/** Sanitizes every value projected from a credential-bearing verification. */
export class VerificationRedaction {
  private readonly secrets: readonly string[];

  public constructor(values: readonly string[]) {
    const secrets = new Set<string>();
    for (const value of values) {
      if (value === "" || value === XRAY_SETUP_MASK) {continue;}
      secrets.add(value);
      if (value.trim() !== "") {secrets.add(value.trim());}
    }
    this.secrets = [...secrets].sort((left, right) => right.length - left.length);
  }

  public text(value: string, fallback: string): string {
    return serverText(maskValues(value, this.secrets)) || fallback;
  }

  public error(error: unknown): string {
    return this.text(errMsg(error), "Unknown error");
  }

  public connectionLabel(outcome: XrayConnectionOutcome): string {
    if (outcome.ok) {
      return this.text(`Connected to ${outcome.site}`, "Connected");
    }
    return outcome.stage === "graphql" ? "Authenticated, but Xray data calls failed" : "Not connected";
  }

  public projectView(outcome: XrayConnectionOutcome): ProjectView {
    return {
      type: "project-view",
      hasJira: outcome.jiraProjects !== undefined || outcome.jiraError !== undefined,
      jiraProjects: (outcome.jiraProjects ?? []).slice(0, 200).map((project) => ({
        key: this.text(project.key, "[redacted]"),
        name: this.text(project.name, "[redacted]"),
      })),
      jiraTruncated: outcome.jiraTruncated === true,
      probed: (outcome.projects ?? []).slice(0, 3).map((project) => ({
        project: this.text(project.project, "[redacted]"),
        totalTests: project.totalTests,
        ...(project.existsOnSite !== undefined ? { existsOnSite: project.existsOnSite } : {}),
      })),
      ...(outcome.jiraError !== undefined
        ? { jiraError: this.text(outcome.jiraError, "Jira project list unavailable") }
        : {}),
    };
  }
}
