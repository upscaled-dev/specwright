export const REMOTE_OPERATION_NAMES = [
  "xray.authenticate", "xray.graphql.read", "xray.test.create", "xray.test-set.create",
  "xray.test-plan.create", "xray.test-set.add-tests", "xray.test-plan.add-tests", "xray.execution.create",
  "xray.gherkin.update", "xray.execution.import-json", "xray.execution.import-cucumber",
  "jira.attachment-meta.read", "jira.attachment.upload", "jira.issue-types.read", "jira.issues.read",
  "jira.projects.read", "jira.profile.read",
] as const;

export type RemoteOperationName = typeof REMOTE_OPERATION_NAMES[number];

const remoteOperationNames = new Set<string>(REMOTE_OPERATION_NAMES);

export function isRemoteOperationName(value: string): value is RemoteOperationName {
  return remoteOperationNames.has(value);
}
