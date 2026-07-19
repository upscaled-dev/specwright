import { Logger } from "../utils/logger";
import { MetadataCapability, SyncScope } from "./contracts";

export interface TraceabilitySyncResult {
  ok: boolean;
  message: string;
  cancelled: boolean;
}

export interface TraceabilitySyncDeps {
  metadata: MetadataCapability;
  scope: SyncScope;
  signal: AbortSignal;
  logger: Logger;
}

/**
 * Drives one metadata sync and reduces it to a toast-ready result. The capability records fetch
 * failures on its snapshot rather than throwing (offline-first), so a non-empty `errors` array is
 * surfaced as a failure without the snapshot's previous completeness being lost. A cancelled run is
 * not an error — the caller shows no toast for it.
 */
export async function runTraceabilitySync(deps: TraceabilitySyncDeps): Promise<TraceabilitySyncResult> {
  try {
    await deps.metadata.sync(deps.scope, deps.signal);
  } catch (error) {
    deps.logger.error(`Traceability sync failed: ${String(error)}`);
    return { ok: false, message: "Sync failed — see the output channel for details.", cancelled: false };
  }
  if (deps.signal.aborted) {
    return { ok: true, message: "Sync cancelled.", cancelled: true };
  }
  const snapshot = deps.metadata.snapshot();
  if (snapshot.errors.length > 0) {
    for (const message of snapshot.errors) {
      deps.logger.error(`Traceability sync reported: ${message}`);
    }
    return { ok: false, message: "Sync completed with errors — see the output channel for details.", cancelled: false };
  }
  const count = snapshot.tests.size;
  return { ok: true, message: `Synced ${count} remote test${count === 1 ? "" : "s"}.`, cancelled: false };
}
