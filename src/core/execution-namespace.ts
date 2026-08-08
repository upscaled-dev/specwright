import * as path from "node:path";
import type { AdmissionRecord, AdmissionStore } from "./execution-admission";
import type { ExecutionIdentity } from "./run-contracts";

const SEGMENT = /^[a-z0-9][a-z0-9.-]*$/;
const PREFIX = "specwright.execution";

export interface StateStore {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

function segment(value: string): string {
  if (!SEGMENT.test(value)) {throw new Error(`Invalid execution namespace segment: ${value}`);}
  return value;
}

export function executionNamespace(identity: ExecutionIdentity): string {
  return `${segment(identity.engine)}.${segment(identity.schemaProfile)}`;
}

export function executionStateKey(identity: ExecutionIdentity, key: string): string {
  return `${PREFIX}.${executionNamespace(identity)}.${key}`;
}

export function executionStorageRoot(root: string, identity: ExecutionIdentity): string {
  return path.join(root, "execution", segment(identity.engine), segment(identity.schemaProfile));
}

/** A view that exposes only one engine and schema profile to a stateful dependency. */
export class NamespacedStateStore implements StateStore {
  constructor(
    private readonly state: StateStore,
    private readonly identity: ExecutionIdentity
  ) {}

  public keys(): readonly string[] {
    const prefix = `${executionStateKey(this.identity, "")}`;
    return this.state.keys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    const namespaced = executionStateKey(this.identity, key);
    return defaultValue === undefined
      ? this.state.get<T>(namespaced)
      : this.state.get<T>(namespaced, defaultValue);
  }

  public update(key: string, value: unknown): PromiseLike<void> {
    return this.state.update(executionStateKey(this.identity, key), value);
  }
}

export class ExecutionNamespaceMigration {
  private readonly marker: string;

  constructor(
    private readonly state: StateStore,
    private readonly identity: ExecutionIdentity
  ) {
    this.marker = executionStateKey(identity, "migration.legacy-v1");
  }

  /** Copy legacy extension state once. The source stays intact as rollback evidence. */
  public async stateKeys(keys: readonly string[]): Promise<void> {
    if (this.state.get<boolean>(this.marker) === true) {return;}
    for (const key of keys) {
      const destination = executionStateKey(this.identity, key);
      if (this.state.get(destination) !== undefined) {continue;}
      const legacy = this.state.get(key);
      if (legacy !== undefined) {await this.state.update(destination, legacy);}
    }
    await this.state.update(this.marker, true);
  }

}

/** Mixed-version view: old and new builds observe every lease throughout the compatibility window. */
export class CompatibleAdmissionStore implements AdmissionStore {
  constructor(
    private readonly primary: AdmissionStore,
    private readonly legacy: AdmissionStore
  ) {}

  public async readAll(): Promise<readonly AdmissionRecord[]> {
    const primary = await this.primary.readAll();
    const combined = new Map(primary.map((record) => [record.id, record]));
    for (const record of await this.legacy.readAll()) {
      const existing = combined.get(record.id);
      if (existing && JSON.stringify(existing.value) !== JSON.stringify(record.value)) {
        throw new Error(`Execution admission record ${record.id} disagrees across compatibility stores.`);
      }
      combined.set(record.id, record);
    }
    return [...combined.values()];
  }

  public async write(record: Parameters<AdmissionStore["write"]>[0]): Promise<void> {
    await this.legacy.write(record);
    await this.primary.write(record);
  }

  public async remove(id: string): Promise<void> {
    await this.primary.remove(id);
    await this.legacy.remove(id);
  }
}
