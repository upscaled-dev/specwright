import {
  ExecutionRef,
  NotSupportedError,
  PublishOutcome,
  PublishRequest,
  PublishTarget,
  ResultPublishingCapability,
  RunArtifact,
} from "../traceability/contracts";
import { publishableResults, PublishableResult } from "../traceability/publish-core";
import {
  EmbeddedEvidence,
  EvidenceEmbedder,
  EvidenceFs,
  EvidenceSkip,
  evidenceRoots,
  nodeEvidenceFs,
  resolveEvidencePath,
  summarizeEvidenceSkips,
} from "../traceability/evidence-resolution";
import { Logger } from "../utils/logger";
import { XrayJiraCredentials } from "./xray-credential-store";
import {
  CucumberMultipartImporter,
  EvidenceForResult,
  ExecutionImportResponse,
  ImportTransport,
  StepResolver,
  XrayJsonImporter,
} from "./execution-importers";
import { ISSUE_TYPE_NAME, JiraIssueKind, searchJiraIssues, JiraIssueSearchResult } from "./jira-issue-search";
import { IssueTypeResolution, resolveExecutionIssueType } from "./jira-issue-types";
import { JiraProjectSearchResult, searchJiraProjects } from "./jira-project-search";

export type AttachTo = "evidence" | "issue" | "both";

export type IssueSearcher = (deps: {
  site: string;
  credentials: XrayJiraCredentials;
  kind: JiraIssueKind;
  query: string;
  logger: Logger;
  signal?: AbortSignal | undefined;
}) => Promise<JiraIssueSearchResult>;

export type ProjectSearcher = (deps: {
  site: string;
  credentials: XrayJiraCredentials;
  query: string;
  logger: Logger;
  signal?: AbortSignal | undefined;
}) => Promise<JiraProjectSearchResult>;

export type IssueTypeResolver = (deps: {
  site: string;
  credentials: XrayJiraCredentials;
  projectKey: string;
  logger: Logger;
  signal?: AbortSignal | undefined;
}) => Promise<IssueTypeResolution>;

export interface XrayResultPublishingDeps {
  transport: ImportTransport;
  // Read fresh each call (never snapshotted): the normalized site host and its optional Jira creds.
  site: () => string;
  jiraCredentials: () => Promise<XrayJiraCredentials | undefined>;
  // Create-mode source resolution + the owning workspace root (per feature, multi-root aware) for the
  // cucumber `uri` relativization AND for resolving evidence refs against their shard's run folder.
  resolveSteps: StepResolver;
  workspaceRootFor: (filePath: string) => string | undefined;
  // Where per-result evidence goes: `evidence` = in the payload, `issue` = uploaded to the execution
  // issue, `both`. Read fresh each publish so a settings change mid-session is honored.
  attachTo: () => AttachTo;
  logger: Logger;
  // Injectable for tests; default to the live fs / Jira issue search.
  evidenceFs?: EvidenceFs | undefined;
  searchIssues?: IssueSearcher | undefined;
  searchProjects?: ProjectSearcher | undefined;
  resolveIssueType?: IssueTypeResolver | undefined;
}

const cucumberImporter = new CucumberMultipartImporter();
const xrayJsonImporter = new XrayJsonImporter();

function executionKeyOf(response: ExecutionImportResponse, request: PublishRequest): string {
  if (response.key !== undefined) {
    return response.key;
  }
  if (request.mode === "append") {
    return request.executionKey;
  }
  return response.id ?? "";
}

function toPublishTarget(issue: { key: string; summary: string }): PublishTarget {
  return { id: issue.key, label: `${issue.key} · ${issue.summary}`, ref: { key: issue.key } };
}

interface EvidencePlan {
  readonly evidenceFor: EvidenceForResult;
  readonly issueFiles: readonly string[];
  readonly notes: readonly string[];
}

// One resolution pass over the publishable set, split by the `attachTo` mode: `evidence`/`both` reads
// + base64-embeds under the shared size budget; `issue`/`both` resolves refs to absolute paths for the
// post-import Jira upload. Missing files are noted once regardless of stream — never a crash.
//
// `jiraAvailable` guards the issue stream: without Jira credentials there is no destination for the
// upload, so an `issue`/`both` mode FALLS BACK to embedding in the payload (never silently loses the
// evidence and never leaves un-clearable `pendingAttachments`), with an honest surfaced note.
function planEvidence(
  artifact: RunArtifact,
  results: readonly PublishableResult[],
  deps: XrayResultPublishingDeps,
  jiraAvailable: boolean
): EvidencePlan {
  const mode = deps.attachTo();
  const fsImpl = deps.evidenceFs ?? nodeEvidenceFs;
  const roots = evidenceRoots(
    artifact.shards.map((shard) => shard.workingDir),
    deps.workspaceRootFor
  );
  const wantsIssue = mode === "issue" || mode === "both";
  const issueFallback = wantsIssue && !jiraAvailable;
  const wantEmbed = mode === "evidence" || mode === "both" || issueFallback;
  const wantIssue = wantsIssue && jiraAvailable;
  const embedder = new EvidenceEmbedder(fsImpl);
  const perResult = new Map<PublishableResult, EmbeddedEvidence[]>();
  const issueFiles: string[] = [];
  const missing: EvidenceSkip[] = [];

  for (const result of results) {
    const embeds: EmbeddedEvidence[] = [];
    for (const ref of result.evidenceRefs) {
      const abs = resolveEvidencePath(ref, roots, fsImpl.exists);
      if (abs === undefined) {
        missing.push({ ref, reason: "missing" });
        continue;
      }
      if (wantEmbed) {
        const embedded = embedder.embed(ref, abs);
        if (embedded !== undefined) {
          embeds.push(embedded);
        }
      }
      if (wantIssue) {
        issueFiles.push(abs);
      }
    }
    if (embeds.length > 0) {
      perResult.set(result, embeds);
    }
  }

  const notes: string[] = [];
  if (issueFallback) {
    notes.push("Jira credentials missing — evidence embedded in the payload instead.");
  }
  const skipNote = summarizeEvidenceSkips([...embedder.skips, ...missing]);
  if (skipNote !== undefined) {
    notes.push(skipNote);
  }
  return { evidenceFor: (result) => perResult.get(result) ?? [], issueFiles, notes };
}

// A successful createmeta listing that lacks the execution type is proof the create would 400
// (`issuetype: Specify a valid issue type`), so it fails fast with the project's actual types; an
// `unknown` resolution (transient fault) never blocks a publish that might still succeed.
function unavailableIssueTypeMessage(projectKey: string, availableNames: string[], teamManaged: boolean): string {
  const remedy = "Enable Xray for this project in Jira, or publish to a project that has the Xray issue types.";
  if (availableNames.length === 0) {
    return `Project ${projectKey} has no "${ISSUE_TYPE_NAME.execution}" issue type, and no issue types are available to your account in this project. ${remedy}`;
  }
  if (teamManaged) {
    return `Project ${projectKey} has no "${ISSUE_TYPE_NAME.execution}" issue type. Its issue types are: ${availableNames.join(", ")}. This is a team-managed project: create a "${ISSUE_TYPE_NAME.execution}" work type in its project settings, map it under Xray Settings > Work Types Mapping, then retry.`;
  }
  return `Project ${projectKey} has no "${ISSUE_TYPE_NAME.execution}" issue type. Its issue types are: ${availableNames.join(", ")}. ${remedy}`;
}

async function publishCreate(
  deps: XrayResultPublishingDeps,
  resolveIssueType: IssueTypeResolver,
  artifact: RunArtifact,
  results: readonly PublishableResult[],
  request: Extract<PublishRequest, { mode: "create-new" }>,
  signal: AbortSignal | undefined,
  credentials: XrayJiraCredentials | undefined
): Promise<PublishOutcome> {
  if (request.summary.trim() === "") {
    throw new Error("Enter a summary for the new execution before publishing.");
  }
  let issueTypeName: string | undefined;
  if (credentials !== undefined) {
    const resolution = await resolveIssueType({
      site: deps.site(),
      credentials,
      projectKey: request.project,
      logger: deps.logger,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (resolution.kind === "unavailable") {
      throw new Error(unavailableIssueTypeMessage(request.project, resolution.availableNames, resolution.teamManaged));
    }
    if (resolution.kind === "resolved") {
      issueTypeName = resolution.name;
    }
  }
  const plan = planEvidence(artifact, results, deps, credentials !== undefined);
  const payload = cucumberImporter.buildPayload({
    artifact,
    results,
    request,
    resolveSteps: deps.resolveSteps,
    workspaceRootFor: deps.workspaceRootFor,
    evidenceFor: plan.evidenceFor,
    issueTypeName,
  });
  const response = await cucumberImporter.import(deps.transport, payload, signal);
  const ref: ExecutionRef = { kind: "execution", key: executionKeyOf(response, request) };
  const warnings: string[] = [];
  if (payload.droppedChangedCount > 0) {
    warnings.push(`${payload.droppedChangedCount} scenario(s) changed since the run and were not published.`);
  }
  warnings.push(...plan.notes);
  return { ref, imported: results.length - payload.droppedChangedCount, warnings, issueEvidenceFiles: plan.issueFiles };
}

async function publishAppend(
  deps: XrayResultPublishingDeps,
  artifact: RunArtifact,
  results: readonly PublishableResult[],
  request: Extract<PublishRequest, { mode: "append" }>,
  signal: AbortSignal | undefined,
  jiraAvailable: boolean
): Promise<PublishOutcome> {
  const plan = planEvidence(artifact, results, deps, jiraAvailable);
  const payload = xrayJsonImporter.buildPayload({ artifact, results, request, evidenceFor: plan.evidenceFor });
  const response = await xrayJsonImporter.import(deps.transport, payload, signal);
  return {
    ref: { kind: "execution", key: executionKeyOf(response, request) },
    imported: results.length,
    warnings: [...plan.notes],
    issueEvidenceFiles: plan.issueFiles,
  };
}

/**
 * The Xray `resultPublishing` capability: reconcile → importer → client. `searchTargets` needs Jira
 * credentials (the GraphQL schema has no execution/plan query — §5); without them it rejects with a
 * `NotSupportedError` and the dialog falls back to a plain key input. `publish` reconciles INSIDE
 * (importers never see an excluded/keyless result) and its single import POST creates the execution
 * WITH results — nothing runs remotely.
 */
export function createXrayResultPublishing(deps: XrayResultPublishingDeps): ResultPublishingCapability {
  const searchIssues = deps.searchIssues ?? searchJiraIssues;
  const searchProjects = deps.searchProjects ?? searchJiraProjects;
  const resolveIssueType = deps.resolveIssueType ?? resolveExecutionIssueType;
  return {
    async searchTargets(kind, query, signal): Promise<readonly PublishTarget[]> {
      const credentials = await deps.jiraCredentials();
      if (credentials === undefined) {
        throw new NotSupportedError(
          "Searching Jira needs credentials, add them in Xray setup, or type the key directly."
        );
      }
      // Projects have no JQL query: the endpoint's own `query` parameter narrows on key and name, so
      // the match happens server-side and a hit past the project cap is still found.
      if (kind === "project") {
        const result = await searchProjects({
          site: deps.site(),
          credentials,
          query,
          logger: deps.logger,
          ...(signal !== undefined ? { signal } : {}),
        });
        return result.projects.map((project) => toPublishTarget({ key: project.key, summary: project.name }));
      }
      const result = await searchIssues({
        site: deps.site(),
        credentials,
        kind,
        query,
        logger: deps.logger,
        ...(signal !== undefined ? { signal } : {}),
      });
      return result.issues.map(toPublishTarget);
    },
    async publish(artifact, request, signal): Promise<PublishOutcome> {
      const results = publishableResults(artifact).publishable;
      // Jira creds are both the issue-attachment destination's only key AND the createmeta resolver's
      // credential, so the object itself (not just its presence) flows into the create path. `planEvidence`
      // still only needs presence, to fall the issue stream back to payload embedding (never a lost blob).
      const credentials = await deps.jiraCredentials();
      return request.mode === "create-new"
        ? publishCreate(deps, resolveIssueType, artifact, results, request, signal, credentials)
        : publishAppend(deps, artifact, results, request, signal, credentials !== undefined);
    },
  };
}
