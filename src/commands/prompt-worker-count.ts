import * as os from "node:os";
import * as vscode from "vscode";
import {
  ExtensionConfig,
  MAX_PARALLEL_PROCESSES_MAX,
  MAX_PARALLEL_PROCESSES_MIN,
} from "../core/extension-config";
import { Logger } from "../utils/logger";

export const PROMPTED_STATE_KEY = "playwrightBddRunner.parallelProfilePrompted";
const CONFIG_NAMESPACE = "playwrightBddRunner";
const MAX_PARALLEL_PROCESSES_SETTING = "maxParallelProcesses";

export interface WorkerCountResolution {
  workers: number;
  autoAdjusted: boolean;
  previousInvalid?: number | undefined;
}

export function resolveWorkerCount(config: ExtensionConfig, logger: Logger): number {
  return resolveWorkerCountDetailed(config, logger).workers;
}

export function resolveWorkerCountDetailed(config: ExtensionConfig, logger: Logger): WorkerCountResolution {
  const raw = config.maxParallelProcesses;
  if (
    Number.isInteger(raw) &&
    raw >= MAX_PARALLEL_PROCESSES_MIN &&
    raw <= MAX_PARALLEL_PROCESSES_MAX
  ) {
    return { workers: raw, autoAdjusted: false };
  }

  const auto = Math.max(
    MAX_PARALLEL_PROCESSES_MIN,
    Math.min(MAX_PARALLEL_PROCESSES_MAX, os.cpus().length - 2)
  );
  logger.warn(
    `Invalid playwrightBddRunner.maxParallelProcesses=${String(raw)}; auto-adjusted to ${auto} (CPU cores - 2, clamped to [${MAX_PARALLEL_PROCESSES_MIN}, ${MAX_PARALLEL_PROCESSES_MAX}]).`
  );
  return { workers: auto, autoAdjusted: true, previousInvalid: raw };
}

export async function ensureWorkerCount(
  workspaceState: vscode.Memento,
  config: ExtensionConfig,
  logger: Logger
): Promise<WorkerCountResolution | undefined> {
  const alreadyPrompted = workspaceState.get<boolean>(PROMPTED_STATE_KEY);
  if (alreadyPrompted || hasExplicitWorkerCount()) {
    return resolveWorkerCountDetailed(config, logger);
  }

  const chosen = await promptUserForWorkerCount();
  if (chosen === undefined) {
    return undefined;
  }

  const target =
    vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE)
    .update(MAX_PARALLEL_PROCESSES_SETTING, chosen, target);
  await workspaceState.update(PROMPTED_STATE_KEY, true);

  vscode.window
    .showInformationMessage(
      "Worker count saved to 'playwrightBddRunner.maxParallelProcesses'. Adjust later via Settings → Extensions → Specwright."
    )
    .then(undefined, () => { /* ignore */ });

  return { workers: chosen, autoAdjusted: false };
}

// A user who already set maxParallelProcesses themselves must not be prompted (and silently
// overwritten) on first parallel run; the prompt exists only to seed a missing value.
function hasExplicitWorkerCount(): boolean {
  const inspected = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE)
    .inspect<number>(MAX_PARALLEL_PROCESSES_SETTING);
  return (
    inspected !== undefined &&
    (inspected.globalValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.workspaceFolderValue !== undefined)
  );
}

async function promptUserForWorkerCount(): Promise<number | undefined> {
  const items: vscode.QuickPickItem[] = [
    { label: "1" },
    { label: "2" },
    { label: "4 (default)" },
    { label: "8" },
    { label: "16" },
    { label: "Custom…" },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Run in Parallel — choose worker count",
    placeHolder: "Select the number of Playwright workers",
    ignoreFocusOut: true,
  });
  if (!pick) {
    return undefined;
  }

  if (pick.label === "Custom…") {
    const input = await vscode.window.showInputBox({
      title: "Custom worker count",
      prompt: `Enter an integer between ${MAX_PARALLEL_PROCESSES_MIN} and ${MAX_PARALLEL_PROCESSES_MAX}`,
      ignoreFocusOut: true,
      validateInput: (value: string): string | undefined => {
        const trimmed = value.trim();
        if (trimmed === "") {
          return "Value is required";
        }
        if (!/^\d+$/.test(trimmed)) {
          return `Enter an integer between ${MAX_PARALLEL_PROCESSES_MIN} and ${MAX_PARALLEL_PROCESSES_MAX}.`;
        }
        const n = Number.parseInt(trimmed, 10);
        if (n < MAX_PARALLEL_PROCESSES_MIN || n > MAX_PARALLEL_PROCESSES_MAX) {
          return `Must be between ${MAX_PARALLEL_PROCESSES_MIN} and ${MAX_PARALLEL_PROCESSES_MAX}`;
        }
        return undefined;
      },
    });
    if (input === undefined) {
      return undefined;
    }
    return Number.parseInt(input.trim(), 10);
  }

  const numericMatch = /^(\d+)/.exec(pick.label);
  return numericMatch?.[1] ? Number.parseInt(numericMatch[1], 10) : undefined;
}
