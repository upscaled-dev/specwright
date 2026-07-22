import { AttachmentSuggestion, PublishAttachmentsModel } from "../traceability/publish-flow";
import { EVIDENCE_MAX_FILE_BYTES } from "../traceability/evidence-resolution";
import { attachmentUploadLimit, JiraAttachmentMeta } from "./jira-attachments";

// The run-level attachments section surfaces at most this many discovered chips — a `playwright-report`
// tree matches many files, so the list is capped (per-file chips by design) and the user unchecks noise.
const MAX_SUGGESTIONS = 25;

const NO_JIRA_REASON =
  "Add Jira access in Xray setup to attach run-level report bundles to the execution's Jira issue.";
const DISABLED_REASON = "Attachments are disabled for this Jira site.";

// The seams the model build reads through (all injected so the whole thing is unit-testable without a
// vscode host): glob discovery, file sizing, and the site's attachment settings.
export interface AttachmentModelDeps {
  reportGlobs: readonly string[];
  attachTo: "evidence" | "issue" | "both";
  // Jira credentials present — the section's `available` signal (the same source the upload routine
  // guards on). No creds ⇒ the section renders disabled, never a stuck upload.
  jiraAvailable: boolean;
  findFiles: (glob: string) => Promise<readonly string[]>;
  fileSize: (path: string) => number | undefined;
  baseName: (path: string) => string;
  // Fetched once per dialog open — only when `jiraAvailable`, so a no-creds run makes no remote call.
  attachmentMeta: () => Promise<JiraAttachmentMeta>;
}

/**
 * Builds the Publish dialog's run-level attachments section. Without Jira credentials it returns a
 * disabled section with an honest reason (no probe, no discovery). With them it fetches the site's
 * `attachment/meta` (the one allowed pre-confirm call), disables the section when the site turns
 * attachments off, and otherwise seeds glob-discovered suggestion chips (deduped, capped, sized).
 */
export async function buildAttachmentsModel(deps: AttachmentModelDeps): Promise<PublishAttachmentsModel> {
  if (!deps.jiraAvailable) {
    return {
      available: false,
      reason: NO_JIRA_REASON,
      suggestions: [],
      uploadLimitBytes: EVIDENCE_MAX_FILE_BYTES,
      evidenceStream: deps.attachTo,
    };
  }
  const meta = await deps.attachmentMeta();
  const uploadLimitBytes = attachmentUploadLimit(meta);
  if (!meta.enabled) {
    return { available: false, reason: DISABLED_REASON, suggestions: [], uploadLimitBytes, evidenceStream: deps.attachTo };
  }
  return { available: true, suggestions: await discoverSuggestions(deps), uploadLimitBytes, evidenceStream: deps.attachTo };
}

async function discoverSuggestions(deps: AttachmentModelDeps): Promise<AttachmentSuggestion[]> {
  const seen = new Set<string>();
  const out: AttachmentSuggestion[] = [];
  for (const glob of deps.reportGlobs) {
    let paths: readonly string[];
    try {
      paths = await deps.findFiles(glob);
    } catch {
      continue;
    }
    for (const filePath of paths) {
      if (seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      const size = deps.fileSize(filePath);
      if (size === undefined) {
        continue;
      }
      out.push({ path: filePath, name: deps.baseName(filePath), size });
      if (out.length >= MAX_SUGGESTIONS) {
        return out;
      }
    }
  }
  return out;
}
