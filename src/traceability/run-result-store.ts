import * as vscode from "vscode";
import { ScenarioStatus } from "../utils/playwright-json-parser";

/**
 * Session-scoped, provider-neutral badge feed (§3.5). The playwright-bdd runner's own JSON report is
 * ephemeral (a tmp file, deleted right after parsing), so an extension-launched run leaves nothing on
 * disk for the tree to read. This store retains the parsed outcomes for the session, keyed exactly
 * like {@link PlaywrightJsonParser.toStatusMap} (`path:line` / `path::name`, one entry per outline
 * iteration), so the model's badge lookup reads it the same way it reads the workspace-report scan,
 * and, unlike the scan, updates live the moment a Test Explorer run finishes. This is only the badge
 * subset of the future `RunArtifactStore`; shards, evidence, and immutable artifacts land in P2.
 */
export class RunResultStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;
  private readonly statuses = new Map<string, ScenarioStatus>();
  private _lastIngestAt = 0;

  // When the most recent extension-run outcomes landed. The model compares this against the workspace
  // report's mtime so a newer external CLI run can win over stale store data (whole-map, coarse). 0
  // until the first non-empty ingest; a never-fed store then collapses to scan-only either way.
  public get lastIngestAt(): number {
    return this._lastIngestAt;
  }

  // Freshest wins per key: the keys this run touched take its outcome, everything else persists, so
  // running one scenario updates its badge live without clearing the others. Fires once, only when
  // something actually changed, so an identical re-run doesn't churn the tree.
  public ingest(statusMap: Record<string, ScenarioStatus>): void {
    const entries = Object.entries(statusMap);
    if (entries.length === 0) {
      return;
    }
    this._lastIngestAt = Date.now();
    let changed = false;
    for (const [key, status] of entries) {
      if (this.statuses.get(key) !== status) {
        this.statuses.set(key, status);
        changed = true;
      }
    }
    if (changed) {
      this._onDidChange.fire();
    }
  }

  public statusMap(): Record<string, ScenarioStatus> {
    return Object.fromEntries(this.statuses);
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }
}
