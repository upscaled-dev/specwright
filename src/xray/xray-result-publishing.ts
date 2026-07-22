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
import { Logger } from "../utils/logger";
import { XrayJiraCredentials } from "./xray-credential-store";
import {
  CucumberMultipartImporter,
  ExecutionImportResponse,
  ImportTransport,
  StepResolver,
  XrayJsonImporter,
} from "./execution-importers";
import { JiraIssueKind, searchJiraIssues, JiraIssueSearchResult } from "./jira-issue-search";

export type IssueSearcher = (deps: {
  site: string;
  credentials: XrayJiraCredentials;
  kind: JiraIssueKind;
  query: string;
  logger: Logger;
  signal?: AbortSignal | undefined;
}) => Promise<JiraIssueSearchResult>;

export interface XrayResultPublishingDeps {
  transport: ImportTransport;
  // Read fresh each call (never snapshotted): the normalized site host and its optional Jira creds.
  site: () => string;
  jiraCredentials: () => Promise<XrayJiraCredentials | undefined>;
  // Create-mode source resolution + the owning workspace root for the cucumber `uri` relativization.
  resolveSteps: StepResolver;
  workspaceRootFor: (filePath: string) => string | undefined;
  logger: Logger;
  // Injectable for tests; defaults to the live Jira issue search.
  searchIssues?: IssueSearcher | undefined;
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
  return { id: issue.key, label: `${issue.key} — ${issue.summary}`, ref: { key: issue.key } };
}

async function publishCreate(
  deps: XrayResultPublishingDeps,
  artifact: RunArtifact,
  results: readonly PublishableResult[],
  request: Extract<PublishRequest, { mode: "create-new" }>,
  signal: AbortSignal | undefined
): Promise<PublishOutcome> {
  const first = results[0]?.scenario.filePath;
  const workspaceRoot = first !== undefined ? deps.workspaceRootFor(first) : undefined;
  const payload = cucumberImporter.buildPayload({
    artifact,
    results,
    request,
    resolveSteps: deps.resolveSteps,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  });
  const response = await cucumberImporter.import(deps.transport, payload, signal);
  const ref: ExecutionRef = { kind: "execution", key: executionKeyOf(response, request) };
  const warnings =
    payload.droppedChangedCount > 0
      ? [`${payload.droppedChangedCount} scenario(s) changed since the run and were not published.`]
      : [];
  return { ref, imported: results.length - payload.droppedChangedCount, warnings };
}

async function publishAppend(
  deps: XrayResultPublishingDeps,
  artifact: RunArtifact,
  results: readonly PublishableResult[],
  request: Extract<PublishRequest, { mode: "append" }>,
  signal: AbortSignal | undefined
): Promise<PublishOutcome> {
  const payload = xrayJsonImporter.buildPayload({ artifact, results, request });
  const response = await xrayJsonImporter.import(deps.transport, payload, signal);
  return { ref: { kind: "execution", key: executionKeyOf(response, request) }, imported: results.length, warnings: [] };
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
  return {
    async searchTargets(kind, query, signal): Promise<readonly PublishTarget[]> {
      const credentials = await deps.jiraCredentials();
      if (credentials === undefined) {
        throw new NotSupportedError(
          "Searching Xray executions needs Jira credentials — add them in Xray setup, or type the key directly."
        );
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
    publish(artifact, request, signal): Promise<PublishOutcome> {
      const results = publishableResults(artifact).publishable;
      return request.mode === "create-new"
        ? publishCreate(deps, artifact, results, request, signal)
        : publishAppend(deps, artifact, results, request, signal);
    },
  };
}
