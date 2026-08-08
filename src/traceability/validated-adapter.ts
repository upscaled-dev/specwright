import {
  INTEGRATION_ADAPTER_CAPABILITIES,
  INTEGRATION_ADAPTER_RESPONSE_LIMITS,
  IntegrationAdapterError,
  type IntegrationAdapterCapability,
} from "./adapter-contract";
import type {
  AdapterEvent,
  AttachmentCapability,
  AuthoredTest,
  AutomationBindingCapability,
  AutomationBindingClassification,
  ConnectionCapability,
  ConnectionVerifyResult,
  CoverageCapability,
  DisposableLike,
  ExternalRef,
  KeyGrammar,
  MetadataCapability,
  NormalizedStatus,
  ProjectDirectory,
  ProjectDirectoryCapability,
  PublishOutcome,
  PublishTarget,
  RemoteMetadataSnapshot,
  RemoteSearchCapability,
  RemoteSearchResult,
  RequirementRef,
  ResultPublishingCapability,
  SyncProgress,
  TestAuthoringCapability,
  TestCaseMetadata,
  TraceabilityAdapter,
} from "./contracts";

interface AdapterState {
  active: boolean;
  readonly lifecycle: AbortController;
  disposal?: Promise<void>;
}

type Validator<T> = (value: unknown, budget: ValidationBudget) => value is T;
type BoundaryReporter = (error: IntegrationAdapterError) => void;

class ValidationBudget {
  private remaining = INTEGRATION_ADAPTER_RESPONSE_LIMITS.totalItems;

  public item(): boolean {
    this.remaining -= 1;
    return this.remaining >= 0;
  }

  public text(value: unknown, allowEmpty = true): value is string {
    return this.item()
      && typeof value === "string"
      && value.length <= INTEGRATION_ADAPTER_RESPONSE_LIMITS.stringLength
      && (allowEmpty || value.trim() !== "");
  }

  public array<T>(value: unknown, valid: Validator<T>): value is readonly T[] {
    if (!this.item() || !Array.isArray(value)) {return false;}
    if (value.length > INTEGRATION_ADAPTER_RESPONSE_LIMITS.collectionItems) {return false;}
    for (let index = 0; index < value.length; index += 1) {
      if (!valid(value[index], this)) {return false;}
    }
    return true;
  }

  public map<K, V>(
    value: unknown,
    validKey: Validator<K>,
    validValue: Validator<V>,
    validEntry?: (key: K, value: V) => boolean
  ): value is ReadonlyMap<K, V> {
    if (!this.item() || !(value instanceof Map)) {return false;}
    if (value.size > INTEGRATION_ADAPTER_RESPONSE_LIMITS.collectionItems) {return false;}
    let seen = 0;
    for (const [key, item] of value.entries()) {
      seen += 1;
      if (
        seen > INTEGRATION_ADAPTER_RESPONSE_LIMITS.collectionItems
        || !validKey(key, this)
        || !validValue(item, this)
        || (validEntry !== undefined && !validEntry(key, item))
      ) {
        return false;
      }
    }
    return seen === value.size;
  }
}

const object = (value: unknown, budget: ValidationBudget): value is Record<string, unknown> =>
  budget.item() && typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, budget: ValidationBudget): value is string => budget.text(value);
const nonEmptyText = (value: unknown, budget: ValidationBudget): value is string => budget.text(value, false);
const finiteNumber = (value: unknown, budget: ValidationBudget): value is number =>
  budget.item() && typeof value === "number" && Number.isFinite(value);
const nonNegativeNumber = (value: unknown, budget: ValidationBudget): value is number =>
  finiteNumber(value, budget) && value >= 0;
const boolean = (value: unknown, budget: ValidationBudget): value is boolean =>
  budget.item() && typeof value === "boolean";
const optional = <T>(value: unknown, budget: ValidationBudget, valid: Validator<T>): value is T | undefined =>
  value === undefined || valid(value, budget);
const texts = (value: unknown, budget: ValidationBudget): value is readonly string[] =>
  budget.array(value, text);

function boundaryError(
  code: "malformed-adapter" | "malformed-response" | "provider-failed" | "adapter-disposed",
  adapterId: string,
  detail: string,
  cause?: unknown
): IntegrationAdapterError {
  return new IntegrationAdapterError(
    code,
    `Integration adapter "${adapterId}" ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}

function disposedError(adapterId: string): IntegrationAdapterError {
  return boundaryError("adapter-disposed", adapterId, "is disposed");
}

function responseError(adapterId: string, response: string, cause?: unknown): IntegrationAdapterError {
  return boundaryError("malformed-response", adapterId, `returned malformed ${response}`, cause);
}

function providerError(adapterId: string, operation: string, cause: unknown): IntegrationAdapterError {
  return boundaryError("provider-failed", adapterId, `${operation} failed`, cause);
}

function assertActive(adapterId: string, state: AdapterState): void {
  if (!state.active) {throw disposedError(adapterId);}
}

function checked<T>(
  adapterId: string,
  state: AdapterState,
  response: string,
  read: () => unknown,
  valid: Validator<T>
): T {
  assertActive(adapterId, state);
  try {
    const value = read();
    if (!valid(value, new ValidationBudget())) {throw responseError(adapterId, response);}
    return value;
  } catch (error) {
    if (error instanceof IntegrationAdapterError) {throw error;}
    throw responseError(adapterId, response, error);
  }
}

async function accepted<T>(
  adapterId: string,
  state: AdapterState,
  operation: string,
  request: () => Promise<unknown>,
  valid: Validator<T>
): Promise<T> {
  assertActive(adapterId, state);
  let value: unknown;
  try {
    value = await request();
  } catch (error) {
    if (error instanceof IntegrationAdapterError) {throw error;}
    throw providerError(adapterId, operation, error);
  }
  return checked(adapterId, state, `${operation} response`, () => value, valid);
}

async function completed(
  adapterId: string,
  state: AdapterState,
  operation: string,
  request: () => Promise<void>
): Promise<void> {
  assertActive(adapterId, state);
  try {
    await request();
  } catch (error) {
    if (error instanceof IntegrationAdapterError) {throw error;}
    throw providerError(adapterId, operation, error);
  }
  assertActive(adapterId, state);
}

function report(reporter: BoundaryReporter, error: unknown): void {
  const stable = error instanceof IntegrationAdapterError
    ? error
    : new IntegrationAdapterError("provider-failed", "Integration adapter event handling failed.", { cause: error });
  try {reporter(stable);} catch { /* logging must not escape into a provider emitter */ }
}

function signalFor(state: AdapterState, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([state.lifecycle.signal, signal]) : state.lifecycle.signal;
}

function ref(value: unknown, budget: ValidationBudget): value is ExternalRef {
  return object(value, budget) && nonEmptyText(value["key"], budget);
}

function requirementRef(value: unknown, budget: ValidationBudget): value is RequirementRef {
  return object(value, budget) && value["kind"] === "requirement" && nonEmptyText(value["key"], budget);
}

function normalizedStatus(value: unknown, budget: ValidationBudget): value is NormalizedStatus {
  if (!object(value, budget) || !text(value["category"], budget) || !text(value["providerValue"], budget)) {
    return false;
  }
  return ["passed", "failed", "pending", "unknown"].includes(value["category"])
    && optional(value["color"], budget, text);
}

function testMetadata(value: unknown, budget: ValidationBudget): value is TestCaseMetadata {
  if (!object(value, budget) || !nonEmptyText(value["key"], budget)) {return false;}
  const testType = value["testType"];
  return optional(value["issueId"], budget, text)
    && optional(value["summary"], budget, text)
    && optional(value["status"], budget, normalizedStatus)
    && optional(value["gherkin"], budget, text)
    && optional(value["coverageKeys"], budget, texts)
    && (testType === undefined
      || (object(testType, budget) && text(testType["name"], budget) && text(testType["kind"], budget)));
}

function snapshot(value: unknown, budget: ValidationBudget): value is RemoteMetadataSnapshot {
  if (!object(value, budget)) {return false;}
  const tests = value["tests"];
  return budget.map(tests, text, testMetadata, (key, item) => item.key === key)
    && texts(value["fetchedScopes"], budget)
    && texts(value["catalogueProjects"], budget)
    && texts(value["completeProjects"], budget)
    && texts(value["verifiedAbsentKeys"], budget)
    && optional(value["syncedAt"], budget, finiteNumber)
    && boolean(value["stale"], budget)
    && texts(value["errors"], budget);
}

function verifyResult(value: unknown, budget: ValidationBudget): value is ConnectionVerifyResult {
  return object(value, budget)
    && text(value["status"], budget)
    && ["ok", "auth-failed", "unreachable"].includes(value["status"])
    && text(value["message"], budget);
}

function authored(value: unknown, budget: ValidationBudget): value is AuthoredTest {
  return object(value, budget)
    && optional(value["key"], budget, text)
    && optional(value["issueId"], budget, text)
    && texts(value["warnings"], budget);
}

function searchResult(value: unknown, budget: ValidationBudget): value is RemoteSearchResult {
  return object(value, budget)
    && budget.array(value["tests"], testMetadata)
    && boolean(value["complete"], budget);
}

function directory(value: unknown, budget: ValidationBudget): value is ProjectDirectory {
  return object(value, budget)
    && budget.array(value["projects"], (project, nested): project is { key: string; name: string } =>
      object(project, nested) && text(project["key"], nested) && text(project["name"], nested)
    )
    && boolean(value["truncated"], budget);
}

function target(value: unknown, budget: ValidationBudget): value is PublishTarget {
  return object(value, budget)
    && text(value["id"], budget)
    && text(value["label"], budget)
    && ref(value["ref"], budget);
}

function outcome(value: unknown, budget: ValidationBudget): value is PublishOutcome {
  if (!object(value, budget) || !object(value["ref"], budget) || value["ref"]["kind"] !== "execution") {
    return false;
  }
  return nonEmptyText(value["ref"]["key"], budget)
    && nonNegativeNumber(value["imported"], budget)
    && texts(value["warnings"], budget)
    && optional(value["issueEvidenceFiles"], budget, texts)
    && optional(value["operationId"], budget, text);
}

function progressEvent(
  value: unknown,
  budget: ValidationBudget
): value is { projectKey: string; fetched: number; total?: number | undefined } {
  return object(value, budget)
    && text(value["projectKey"], budget)
    && nonNegativeNumber(value["fetched"], budget)
    && optional(value["total"], budget, nonNegativeNumber);
}

const voidEvent = (value: unknown, budget: ValidationBudget): value is void =>
  budget.item() && value === undefined;
const truth = (value: unknown, budget: ValidationBudget): value is boolean => boolean(value, budget);
const optionalText = (value: unknown, budget: ValidationBudget): value is string | undefined =>
  optional(value, budget, text);
const requirementRefs = (value: unknown, budget: ValidationBudget): value is readonly RequirementRef[] =>
  budget.array(value, requirementRef);
const targets = (value: unknown, budget: ValidationBudget): value is readonly PublishTarget[] =>
  budget.array(value, target);

function eventOf<T>(
  adapterId: string,
  state: AdapterState,
  response: string,
  event: AdapterEvent<T>,
  valid: Validator<T>,
  reporter: BoundaryReporter
): AdapterEvent<T> {
  return (listener) => {
    assertActive(adapterId, state);
    let subscription: DisposableLike;
    try {
      subscription = event((value) => {
        if (!state.active) {return;}
        try {
          const acceptedValue = checked(adapterId, state, `${response} event`, () => value, valid);
          listener(acceptedValue);
        } catch (error) {
          report(reporter, error);
        }
      });
    } catch (error) {
      throw providerError(adapterId, `${response} event subscription`, error);
    }
    return checked(
      adapterId,
      state,
      `${response} event subscription`,
      () => subscription,
      (value, budget): value is DisposableLike =>
        object(value, budget) && typeof value["dispose"] === "function"
    );
  };
}

function grammar(value: unknown, budget: ValidationBudget): value is KeyGrammar {
  return object(value, budget)
    && nonEmptyText(value["testPrefix"], budget)
    && nonEmptyText(value["reqPrefix"], budget)
    && budget.item()
    && value["keyShape"] instanceof RegExp
    && budget.item()
    && typeof value["canonicalizeKey"] === "function"
    && (value["projectOf"] === undefined || (budget.item() && typeof value["projectOf"] === "function"));
}

function grammarOf(adapterId: string, state: AdapterState, source: KeyGrammar): KeyGrammar {
  const valid = checked(adapterId, state, "keyGrammar response", () => source, grammar);
  const canonicalizeKey = valid.canonicalizeKey.bind(valid);
  const projectOf = valid.projectOf?.bind(valid);
  return {
    testPrefix: valid.testPrefix,
    reqPrefix: valid.reqPrefix,
    keyShape: valid.keyShape,
    canonicalizeKey: (key) => checked(
      adapterId,
      state,
      "keyGrammar.canonicalizeKey response",
      () => canonicalizeKey(key),
      text
    ),
    ...(projectOf
      ? { projectOf: (key: string) => checked(
          adapterId, state, "keyGrammar.projectOf response", () => projectOf(key), text
        ) }
      : {}),
  };
}

function connectionOf(
  adapterId: string,
  state: AdapterState,
  source: ConnectionCapability,
  reporter: BoundaryReporter
): ConnectionCapability {
  const isConnected = source.isConnected.bind(source);
  const verify = source.verify?.bind(source);
  return {
    onDidChange: eventOf(adapterId, state, "connection.onDidChange", source.onDidChange, voidEvent, reporter),
    get label() {return checked(adapterId, state, "connection.label response", () => source.label, text);},
    isConnected: () => accepted(adapterId, state, "connection.isConnected", isConnected, truth),
    ...(verify
      ? { verify: (signal?: AbortSignal) => accepted(
          adapterId, state, "connection.verify", () => verify(signalFor(state, signal)), verifyResult
        ) }
      : {}),
  };
}

function metadataOf(
  adapterId: string,
  state: AdapterState,
  source: MetadataCapability,
  reporter: BoundaryReporter
): MetadataCapability {
  const readSnapshot = source.snapshot.bind(source);
  const sync = source.sync.bind(source);
  return {
    onDidChange: eventOf(adapterId, state, "metadata.onDidChange", source.onDidChange, voidEvent, reporter),
    snapshot: () => checked(adapterId, state, "metadata.snapshot response", readSnapshot, snapshot),
    sync: async (scope, signal, progress) => {
      const operationSignal = signalFor(state, signal);
      let open = !operationSignal.aborted;
      const close = (): void => {
        open = false;
        operationSignal.removeEventListener("abort", close);
      };
      operationSignal.addEventListener("abort", close, { once: true });
      const reportProgress: SyncProgress | undefined = progress
        ? (value) => {
            if (!open || !state.active) {return;}
            try {
              progress(checked(adapterId, state, "metadata.sync progress event", () => value, progressEvent));
            } catch (error) {
              report(reporter, error);
            }
          }
        : undefined;
      try {
        await completed(
          adapterId,
          state,
          "metadata.sync",
          () => sync(scope, operationSignal, reportProgress)
        );
      } finally {
        close();
      }
    },
  };
}

function coverageOf(adapterId: string, state: AdapterState, source: CoverageCapability): CoverageCapability {
  const coverageFor = source.coverageFor.bind(source);
  return {
    coverageFor: (item, signal) => accepted(
      adapterId, state, "coverage.coverageFor", () => coverageFor(item, signalFor(state, signal)), requirementRefs
    ),
  };
}

function bindingOf(
  adapterId: string,
  state: AdapterState,
  source: AutomationBindingCapability
): AutomationBindingCapability {
  const classify = source.classify.bind(source);
  const bind = source.bind.bind(source);
  const classifications: readonly AutomationBindingClassification[] = [
    "compatible", "incompatible-test-type", "binding-required", "unknown",
  ];
  return {
    classify: (meta) => checked(
      adapterId,
      state,
      "automationBinding.classify response",
      () => classify(meta),
      (value, budget): value is AutomationBindingClassification =>
        text(value, budget) && classifications.includes(value as AutomationBindingClassification)
    ),
    bind: (item, signal) => completed(
      adapterId, state, "automationBinding.bind", () => bind(item, signalFor(state, signal))
    ),
  };
}

function searchOf(adapterId: string, state: AdapterState, source: RemoteSearchCapability): RemoteSearchCapability {
  const search = source.search.bind(source);
  const mergeKeys = source.mergeKeys.bind(source);
  return {
    search: (query, signal) => accepted(
      adapterId, state, "remoteSearch.search", () => search(query, signalFor(state, signal)), searchResult
    ),
    mergeKeys: (keys, signal) => completed(
      adapterId, state, "remoteSearch.mergeKeys", () => mergeKeys(keys, signalFor(state, signal))
    ),
  };
}

function projectsOf(
  adapterId: string,
  state: AdapterState,
  source: ProjectDirectoryCapability
): ProjectDirectoryCapability {
  const cached = source.cached.bind(source);
  const list = source.list.bind(source);
  return {
    cached: () => checked(adapterId, state, "projectDirectory.cached response", cached, directory),
    list: (signal) => accepted(
      adapterId, state, "projectDirectory.list", () => list(signalFor(state, signal)), directory
    ),
  };
}

function authoringOf(
  adapterId: string,
  state: AdapterState,
  source: TestAuthoringCapability
): TestAuthoringCapability {
  const createTest = source.createTest.bind(source);
  const createTestSet = source.createTestSet?.bind(source);
  const createTestPlan = source.createTestPlan?.bind(source);
  const createTestExecution = source.createTestExecution?.bind(source);
  const pushGherkin = source.pushGherkin?.bind(source);
  return {
    createTest: (spec, signal) => accepted(
      adapterId, state, "testAuthoring.createTest", () => createTest(spec, signalFor(state, signal)), authored
    ),
    ...(createTestSet
      ? { createTestSet: (spec, signal) => accepted(
          adapterId, state, "testAuthoring.createTestSet", () => createTestSet(spec, signalFor(state, signal)), authored
        ) }
      : {}),
    ...(createTestPlan
      ? { createTestPlan: (spec, signal) => accepted(
          adapterId, state, "testAuthoring.createTestPlan", () => createTestPlan(spec, signalFor(state, signal)), authored
        ) }
      : {}),
    ...(createTestExecution
      ? { createTestExecution: (spec, signal) => accepted(
          adapterId,
          state,
          "testAuthoring.createTestExecution",
          () => createTestExecution(spec, signalFor(state, signal)),
          authored
        ) }
      : {}),
    ...(pushGherkin
      ? { pushGherkin: (issueId, gherkin, signal) => accepted(
          adapterId,
          state,
          "testAuthoring.pushGherkin",
          () => pushGherkin(issueId, gherkin, signalFor(state, signal)),
          optionalText
        ) }
      : {}),
  };
}

function publishingOf(
  adapterId: string,
  state: AdapterState,
  source: ResultPublishingCapability
): ResultPublishingCapability {
  const searchTargets = source.searchTargets.bind(source);
  const publish = source.publish.bind(source);
  return {
    searchTargets: (kind, query, signal) => accepted(
      adapterId,
      state,
      "resultPublishing.searchTargets",
      () => searchTargets(kind, query, signalFor(state, signal)),
      targets
    ),
    publish: (artifact, request, signal) => accepted(
      adapterId,
      state,
      "resultPublishing.publish",
      () => publish(artifact, request, signalFor(state, signal)),
      outcome
    ),
  };
}

function attachmentsOf(
  adapterId: string,
  state: AdapterState,
  source: AttachmentCapability
): AttachmentCapability {
  const attach = source.attach.bind(source);
  return {
    attach: (target, files, signal) => completed(
      adapterId, state, "attachments.attach", () => attach(target, files, signalFor(state, signal))
    ),
  };
}

const REQUIRED_CAPABILITY_MEMBERS: Readonly<Record<IntegrationAdapterCapability, readonly string[]>> = {
  connection: ["onDidChange", "isConnected"],
  metadata: ["onDidChange", "snapshot", "sync"],
  coverage: ["coverageFor"],
  automationBinding: ["classify", "bind"],
  remoteSearch: ["search", "mergeKeys"],
  projectDirectory: ["cached", "list"],
  testAuthoring: ["createTest"],
  resultPublishing: ["searchTargets", "publish"],
  attachments: ["attach"],
};

const OPTIONAL_CAPABILITY_MEMBERS: Readonly<Partial<Record<IntegrationAdapterCapability, readonly string[]>>> = {
  connection: ["verify"],
  testAuthoring: ["createTestSet", "createTestPlan", "createTestExecution", "pushGherkin"],
};

function capabilityShape(value: unknown, capability: IntegrationAdapterCapability): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return false;}
  const record = value as Record<string, unknown>;
  for (const member of REQUIRED_CAPABILITY_MEMBERS[capability]) {
    if (typeof record[member] !== "function") {return false;}
  }
  for (const member of OPTIONAL_CAPABILITY_MEMBERS[capability] ?? []) {
    if (record[member] !== undefined && typeof record[member] !== "function") {return false;}
  }
  if (capability === "connection" && !new ValidationBudget().text(record["label"])) {return false;}
  return true;
}

export function validateAdapterShape(
  factoryId: string,
  versions: Readonly<Partial<Record<IntegrationAdapterCapability, number>>>,
  adapter: TraceabilityAdapter
): void {
  try {
    const budget = new ValidationBudget();
    if (
      typeof adapter !== "object"
      || adapter === null
      || !budget.text(adapter.id, false)
      || adapter.id !== factoryId
      || !budget.text(adapter.label, false)
      || !grammar(adapter.keyGrammar, budget)
      || typeof adapter.browseUrl !== "function"
      || (adapter.initialize !== undefined && typeof adapter.initialize !== "function")
      || (adapter.dispose !== undefined && typeof adapter.dispose !== "function")
    ) {
      throw boundaryError("malformed-adapter", factoryId, "returned a malformed activation object");
    }
    for (const capability of INTEGRATION_ADAPTER_CAPABILITIES) {
      const value = adapter[capability];
      const declared = versions[capability] !== undefined;
      if (declared !== (value !== undefined) || (declared && !capabilityShape(value, capability))) {
        throw boundaryError(
          "malformed-adapter",
          factoryId,
          `returned malformed activation capability "${capability}"`
        );
      }
    }
  } catch (error) {
    if (error instanceof IntegrationAdapterError) {throw error;}
    throw boundaryError("malformed-adapter", factoryId, "returned a malformed activation object", error);
  }
}

export function validatedAdapter(
  adapter: TraceabilityAdapter,
  dispose: () => Promise<void>,
  reporter: BoundaryReporter
): TraceabilityAdapter {
  const state: AdapterState = { active: true, lifecycle: new AbortController() };
  const adapterId = adapter.id;
  const initialize = adapter.initialize?.bind(adapter);
  const browseUrl = adapter.browseUrl.bind(adapter);
  return {
    id: adapterId,
    get label() {return checked(adapterId, state, "label response", () => adapter.label, text);},
    get keyGrammar() {return grammarOf(adapterId, state, adapter.keyGrammar);},
    browseUrl: (item) => checked(
      adapterId, state, "browseUrl response", () => browseUrl(item), optionalText
    ),
    connection: adapter.connection ? connectionOf(adapterId, state, adapter.connection, reporter) : undefined,
    metadata: adapter.metadata ? metadataOf(adapterId, state, adapter.metadata, reporter) : undefined,
    coverage: adapter.coverage ? coverageOf(adapterId, state, adapter.coverage) : undefined,
    automationBinding: adapter.automationBinding ? bindingOf(adapterId, state, adapter.automationBinding) : undefined,
    remoteSearch: adapter.remoteSearch ? searchOf(adapterId, state, adapter.remoteSearch) : undefined,
    projectDirectory: adapter.projectDirectory ? projectsOf(adapterId, state, adapter.projectDirectory) : undefined,
    testAuthoring: adapter.testAuthoring ? authoringOf(adapterId, state, adapter.testAuthoring) : undefined,
    resultPublishing: adapter.resultPublishing ? publishingOf(adapterId, state, adapter.resultPublishing) : undefined,
    attachments: adapter.attachments ? attachmentsOf(adapterId, state, adapter.attachments) : undefined,
    ...(initialize
      ? { initialize: (signal: AbortSignal) => completed(
          adapterId, state, "initialization", () => initialize(signalFor(state, signal))
        ) }
      : {}),
    dispose: async () => {
      if (!state.disposal) {
        state.active = false;
        state.lifecycle.abort();
        state.disposal = dispose();
      }
      await state.disposal;
    },
  };
}
