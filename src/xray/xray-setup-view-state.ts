import type { SetupHostMessage, SetupRegion } from "../webview/setup-protocol";

type BusyMessage = Extract<SetupHostMessage, { type: "busy" }>;
type ConnectionMessage = Extract<SetupHostMessage, { type: "conn-state" }>;
type FormMessage = Extract<SetupHostMessage, { type: "form-state" }>;
type ProjectMessage = Extract<SetupHostMessage, { type: "project-view" }>;
type StatusMessage = Extract<SetupHostMessage, { type: "test-result" | "error" }>;

/** The bounded host-owned projection replayed when the setup document reloads. */
export class XraySetupViewState {
  private form: FormMessage;
  private connection: ConnectionMessage;
  private busy: BusyMessage = { type: "busy", busy: false, testing: false };
  private status: StatusMessage | undefined;
  private projects: ProjectMessage | undefined;

  public constructor(
    site: string,
    region: SetupRegion,
    credentials: boolean,
    jira: boolean
  ) {
    this.form = { type: "form-state", site, region, credentials, jira };
    this.connection = credentials
      ? { type: "conn-state", state: "checking", label: "Checking connection…" }
      : { type: "conn-state", state: "disconnected", label: "Not connected" };
  }

  public apply(message: SetupHostMessage, retain = true): void {
    switch (message.type) {
      case "busy":
        this.busy = message;
        return;
      case "form-state":
        this.form = message;
        return;
      case "saved":
        this.form = {
          type: "form-state",
          site: message.site,
          region: message.region,
          credentials: true,
          jira: message.jira,
        };
        this.connection = { type: "conn-state", state: "checking", label: "Checking connection…" };
        this.status = undefined;
        this.projects = undefined;
        return;
      case "conn-state":
        this.connection = message;
        return;
      case "project-view":
        this.projects = message;
        return;
      case "validation":
        return;
      case "test-result":
      case "error":
        if (retain) {this.status = message;}
    }
  }

  public snapshot(): readonly SetupHostMessage[] {
    return [
      this.form,
      this.connection,
      ...(this.projects ? [this.projects] : []),
      ...(this.status ? [this.status] : []),
      this.busy,
    ];
  }
}
