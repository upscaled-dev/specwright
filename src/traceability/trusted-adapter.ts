import type { WorkspaceTrust } from "../core/workspace-trust";
import type {
  AttachmentCapability,
  AutomationBindingCapability,
  ConnectionCapability,
  CoverageCapability,
  MetadataCapability,
  ProjectDirectoryCapability,
  RemoteSearchCapability,
  ResultPublishingCapability,
  TestAuthoringCapability,
  TraceabilityAdapter,
} from "./contracts";

function connectionOf(
  capability: ConnectionCapability | undefined,
  trust: WorkspaceTrust
): ConnectionCapability | undefined {
  if (!capability) {return undefined;}
  const verify = capability.verify?.bind(capability);
  return {
    onDidChange: capability.onDidChange,
    get label() {return capability.label;},
    isConnected: () => {
      return trust.available
        ? trust.run(() => capability.isConnected())
        : Promise.resolve(false);
    },
    ...(verify
      ? { verify: (signal?: AbortSignal) =>
          trust.run((trustedSignal) => verify(trustedSignal), signal) }
      : {}),
  };
}

function metadataOf(
  capability: MetadataCapability | undefined,
  trust: WorkspaceTrust
): MetadataCapability | undefined {
  if (!capability) {return undefined;}
  return {
    onDidChange: capability.onDidChange,
    snapshot: () => capability.snapshot(),
    sync: (scope, signal, progress) =>
      trust.run((trustedSignal) => capability.sync(scope, trustedSignal, progress), signal),
  };
}

function coverageOf(
  capability: CoverageCapability | undefined,
  trust: WorkspaceTrust
): CoverageCapability | undefined {
  return capability
    ? { coverageFor: (ref, signal) => trust.run((trusted) => capability.coverageFor(ref, trusted), signal) }
    : undefined;
}

function bindingOf(
  capability: AutomationBindingCapability | undefined,
  trust: WorkspaceTrust
): AutomationBindingCapability | undefined {
  return capability
    ? {
        classify: (meta) => capability.classify(meta),
        bind: (ref, signal) => trust.run((trusted) => capability.bind(ref, trusted), signal),
      }
    : undefined;
}

function searchOf(
  capability: RemoteSearchCapability | undefined,
  trust: WorkspaceTrust
): RemoteSearchCapability | undefined {
  return capability
    ? {
        search: (query, signal) => trust.run((trusted) => capability.search(query, trusted), signal),
        mergeKeys: (keys, signal) => trust.run((trusted) => capability.mergeKeys(keys, trusted), signal),
      }
    : undefined;
}

function projectsOf(
  capability: ProjectDirectoryCapability | undefined,
  trust: WorkspaceTrust
): ProjectDirectoryCapability | undefined {
  return capability
    ? {
        cached: () => {
          const cached = capability.cached();
          if (trust.available) {
            trust.run((signal) => capability.list(signal)).catch(() => undefined);
          }
          return cached;
        },
        list: (signal) => trust.run((trusted) => capability.list(trusted), signal),
      }
    : undefined;
}

function authoringOf(
  capability: TestAuthoringCapability | undefined,
  trust: WorkspaceTrust
): TestAuthoringCapability | undefined {
  if (!capability) {return undefined;}
  const createTestSet = capability.createTestSet?.bind(capability);
  const createTestPlan = capability.createTestPlan?.bind(capability);
  const resolveTestContainer = capability.resolveTestContainer?.bind(capability);
  const addTestsToContainer = capability.addTestsToContainer?.bind(capability);
  const createTestExecution = capability.createTestExecution?.bind(capability);
  const pushGherkin = capability.pushGherkin?.bind(capability);
  return {
    createTest: (spec, signal) => trust.run((trusted) => capability.createTest(spec, trusted), signal),
    ...(createTestSet
      ? { createTestSet: (spec, signal) => trust.run((trusted) => createTestSet(spec, trusted), signal) }
      : {}),
    ...(createTestPlan
      ? { createTestPlan: (spec, signal) => trust.run((trusted) => createTestPlan(spec, trusted), signal) }
      : {}),
    ...(resolveTestContainer
      ? { resolveTestContainer: (kind, key, signal) =>
          trust.run((trusted) => resolveTestContainer(kind, key, trusted), signal) }
      : {}),
    ...(addTestsToContainer
      ? { addTestsToContainer: (kind, issueId, testIssueIds, signal) =>
          trust.run((trusted) => addTestsToContainer(kind, issueId, testIssueIds, trusted), signal) }
      : {}),
    ...(createTestExecution
      ? { createTestExecution: (spec, signal) => trust.run((trusted) => createTestExecution(spec, trusted), signal) }
      : {}),
    ...(pushGherkin
      ? { pushGherkin: (id, gherkin, signal) => trust.run((trusted) => pushGherkin(id, gherkin, trusted), signal) }
      : {}),
  };
}

function publishingOf(
  capability: ResultPublishingCapability | undefined,
  trust: WorkspaceTrust
): ResultPublishingCapability | undefined {
  return capability
    ? {
        searchTargets: (kind, query, signal) =>
          trust.run((trusted) => capability.searchTargets(kind, query, trusted), signal),
        publish: (artifact, request, signal) =>
          trust.run((trusted) => capability.publish(artifact, request, trusted), signal),
      }
    : undefined;
}

function attachmentsOf(
  capability: AttachmentCapability | undefined,
  trust: WorkspaceTrust
): AttachmentCapability | undefined {
  return capability
    ? { attach: (target, files, signal) => trust.run((trusted) => capability.attach(target, files, trusted), signal) }
    : undefined;
}

/** Keeps passive adapter data available while every remote boundary shares trust admission. */
export function trustedAdapter(
  adapter: TraceabilityAdapter,
  trust: WorkspaceTrust
): TraceabilityAdapter {
  return {
    id: adapter.id,
    label: adapter.label,
    get keyGrammar() {return adapter.keyGrammar;},
    browseUrl: (ref) => adapter.browseUrl(ref),
    connection: connectionOf(adapter.connection, trust),
    metadata: metadataOf(adapter.metadata, trust),
    coverage: coverageOf(adapter.coverage, trust),
    automationBinding: bindingOf(adapter.automationBinding, trust),
    remoteSearch: searchOf(adapter.remoteSearch, trust),
    projectDirectory: projectsOf(adapter.projectDirectory, trust),
    testAuthoring: authoringOf(adapter.testAuthoring, trust),
    resultPublishing: publishingOf(adapter.resultPublishing, trust),
    attachments: attachmentsOf(adapter.attachments, trust),
    dispose: () => adapter.dispose?.(),
  };
}
