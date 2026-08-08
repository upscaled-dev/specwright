import { describe, it, expect, vi } from "vitest";
import { FeatureParser } from "../../../parsers/feature-parser";
import {
  buildTraceabilitySnapshot,
  ParsedFeatureInput,
  TraceabilitySnapshot,
} from "../../../traceability/traceability-model";
import { extractKeys } from "../../../traceability/tag-extraction";
import {
  PublishRequest,
  RunArtifact,
  SyncProgress,
  SyncScope,
  TestCaseMetadata,
  TraceabilityAdapter,
} from "../../../traceability/contracts";
import type {
  AdapterServices,
  TraceabilityAdapterFactory,
} from "../../../traceability/adapter-contract";
import { INTEGRATION_ADAPTER_RESPONSE_LIMITS } from "../../../traceability/adapter-contract";
import {
  TraceabilityAdapterRegistry,
} from "../../../traceability/adapter-registry";

// The control surface a provider binds to run the shared contract suite. The in-memory adapter
// implements it directly; a future Xray binding implements it over a mocked transport + credential
// store; the suite itself stays provider-agnostic (drives connect/sync only through this harness
// and the neutral capabilities).
export interface AdapterContractHarness {
  readonly adapter: TraceabilityAdapter;
  readonly factory: TraceabilityAdapterFactory;
  readonly services: AdapterServices;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  // Seed the catalogue the next sync reads, naming the projects whose catalogue lands whole. A project
  // in `syncScope` that is not named pages short, which is how the suite drives a per-project partial.
  seedCatalogue(tests: readonly TestCaseMetadata[], landedProjects: readonly string[]): void;
  seedSyncError(message: string): void;
  // The projects one sync fetches catalogues for. At least two, so a sibling can fall short; the seeded
  // catalogue's keys belong to the first.
  readonly syncScope: SyncScope;
  // A tag set exercising the adapter's grammar, with the canonical keys it must extract.
  readonly grammarSample: {
    readonly tags: string[];
    readonly testKeys: string[];
    readonly reqKeys: string[];
  };
  // A canonical key that is both referenced by `mappedFeature` locally and seeded in the catalogue.
  readonly mappedKey: string;
  // A catalogue key with no local scenario (an orphan on a complete fetch).
  readonly orphanKey: string;
  makeArtifact(): RunArtifact;
  readonly publishRequest: PublishRequest;
}

function mappedFeature(harness: AdapterContractHarness): ParsedFeatureInput {
  const prefix = harness.adapter.keyGrammar.testPrefix;
  const content = `Feature: Contract\n\n@${prefix}${harness.mappedKey}\nScenario: mapped\n  Given a step\n`;
  const parsed = FeatureParser.create().parseFeatureContent(content);
  return { filePath: "/ws/contract.feature", scenarios: parsed?.scenarios ?? [] };
}

function join(harness: AdapterContractHarness): TraceabilitySnapshot {
  const remote = harness.adapter.metadata?.snapshot();
  return buildTraceabilitySnapshot([mappedFeature(harness)], {}, harness.adapter.keyGrammar, remote);
}

function scopeProjects(harness: AdapterContractHarness): readonly string[] {
  return harness.syncScope.projectKeys ?? [];
}

async function activatedHarness(
  makeHarness: () => AdapterContractHarness
): Promise<AdapterContractHarness> {
  const harness = makeHarness();
  const registry = new TraceabilityAdapterRegistry();
  registry.register(harness.factory);
  const adapter = await registry.activate(harness.factory.id, harness.services);
  if (!adapter) {throw new Error(`Contract factory ${harness.factory.id} did not activate`);}
  return { ...harness, adapter };
}

function withMember<T extends object>(source: T, member: PropertyKey, replacement: unknown): T {
  return new Proxy(source, {
    get: (target, property) => property === member ? replacement : Reflect.get(target, property, target),
  });
}

async function activatedWithSync(
  harness: AdapterContractHarness,
  sync: NonNullable<TraceabilityAdapter["metadata"]>["sync"]
): Promise<TraceabilityAdapter> {
  const source = new Proxy(harness.adapter, {
    get: (target, property) => property === "metadata"
      ? withMember(target.metadata!, "sync", sync)
      : Reflect.get(target, property, target),
  });
  const registry = new TraceabilityAdapterRegistry();
  registry.register({ ...harness.factory, create: () => source });
  const adapter = await registry.activate(harness.factory.id, harness.services);
  if (!adapter) {throw new Error(`Contract factory ${harness.factory.id} did not activate`);}
  return adapter;
}

function fireRetainedProgress(progress: SyncProgress | undefined): void {
  const emit = progress as ((value: unknown) => void) | undefined;
  emit?.("malformed");
  emit?.({ projectKey: "P", fetched: 1 });
}

export function runAdapterContractTests(makeHarness: () => AdapterContractHarness): void {
  describe("traceability adapter contract", () => {
    it("activates and disposes through the versioned registry boundary", async () => {
      const harness = makeHarness();
      const registry = new TraceabilityAdapterRegistry();
      registry.register(harness.factory);

      const adapter = await registry.activate(harness.factory.id, harness.services);

      expect(adapter?.id).toBe(harness.factory.id);
      await adapter?.dispose?.();
    });

    it("fails closed on duplicate and incompatible registrations", () => {
      const harness = makeHarness();
      const registry = new TraceabilityAdapterRegistry();
      registry.register(harness.factory);

      expect(() => registry.register(harness.factory)).toThrowError(
        expect.objectContaining({ code: "duplicate-id" })
      );
      expect(() => new TraceabilityAdapterRegistry().register({
        ...harness.factory,
        apiVersion: 999,
      })).toThrowError(expect.objectContaining({ code: "incompatible-api" }));
      const capability = Object.keys(harness.factory.capabilityVersions)[0]!;
      expect(() => new TraceabilityAdapterRegistry().register({
        ...harness.factory,
        capabilityVersions: { ...harness.factory.capabilityVersions, [capability]: 999 },
      })).toThrowError(expect.objectContaining({ code: "incompatible-capability" }));
    });

    it("rejects malformed capability responses before domain state consumes them", async () => {
      const harness = makeHarness();
      const malformed = new Proxy(harness.adapter, {
        get: (target, property) => property === "metadata"
          ? withMember(target.metadata!, "snapshot", () => ({ tests: [] }))
          : Reflect.get(target, property, target),
      });
      const registry = new TraceabilityAdapterRegistry();
      registry.register({ ...harness.factory, create: () => malformed });
      const adapter = (await registry.activate(harness.factory.id, harness.services))!;

      expect(() => adapter.metadata?.snapshot()).toThrowError(
        `Integration adapter "${harness.factory.id}" returned malformed metadata.snapshot response.`
      );
      await adapter.dispose?.();
    });

    it("rejects malformed declared capabilities and throwing activation getters", async () => {
      const malformedHarness = makeHarness();
      const malformed = new Proxy(malformedHarness.adapter, {
        get: (target, property) => property === "metadata" ? null : Reflect.get(target, property, target),
      });
      const malformedRegistry = new TraceabilityAdapterRegistry();
      malformedRegistry.register({ ...malformedHarness.factory, create: () => malformed });
      await expect(malformedRegistry.activate(
        malformedHarness.factory.id,
        malformedHarness.services
      )).rejects.toMatchObject({ code: "malformed-adapter" });

      const throwingHarness = makeHarness();
      const throwing = new Proxy(throwingHarness.adapter, {
        get: (target, property) => {
          if (property === "label") {throw new Error("getter boom");}
          return Reflect.get(target, property, target);
        },
      });
      const throwingRegistry = new TraceabilityAdapterRegistry();
      throwingRegistry.register({ ...throwingHarness.factory, create: () => throwing });
      await expect(throwingRegistry.activate(
        throwingHarness.factory.id,
        throwingHarness.services
      )).rejects.toMatchObject({ code: "malformed-adapter" });
    });

    it("rejects oversized and throwing response collections without walking past the limit", async () => {
      const oversizedHarness = makeHarness();
      const oversizedErrors = new Array<string>(
        INTEGRATION_ADAPTER_RESPONSE_LIMITS.collectionItems + 1
      );
      const guardedErrors = new Proxy(oversizedErrors, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            throw new Error("oversized collection was walked");
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const oversized = new Proxy(oversizedHarness.adapter, {
        get: (target, property) => property === "metadata"
          ? withMember(target.metadata!, "snapshot", () => ({
                tests: new Map(),
                fetchedScopes: [],
                catalogueProjects: [],
                completeProjects: [],
                verifiedAbsentKeys: [],
                stale: false,
                errors: guardedErrors,
              }))
          : Reflect.get(target, property, target),
      });
      const oversizedRegistry = new TraceabilityAdapterRegistry();
      oversizedRegistry.register({ ...oversizedHarness.factory, create: () => oversized });
      const oversizedAdapter = (await oversizedRegistry.activate(
        oversizedHarness.factory.id,
        oversizedHarness.services
      ))!;
      expect(() => oversizedAdapter.metadata!.snapshot()).toThrowError(
        expect.objectContaining({ code: "malformed-response" })
      );

      const iteratorHarness = makeHarness();
      const throwingMap = new Proxy(new Map<string, TestCaseMetadata>(), {
        get: (target, property, receiver) => {
          if (property === "size") {return 1;}
          if (property === "entries") {return () => {throw new Error("iterator boom");};}
          return Reflect.get(target, property, receiver);
        },
      });
      const throwingIterator = new Proxy(iteratorHarness.adapter, {
        get: (target, property) => property === "metadata"
          ? withMember(target.metadata!, "snapshot", () => ({
                tests: throwingMap,
                fetchedScopes: [],
                catalogueProjects: [],
                completeProjects: [],
                verifiedAbsentKeys: [],
                stale: false,
                errors: [],
              }))
          : Reflect.get(target, property, target),
      });
      const iteratorRegistry = new TraceabilityAdapterRegistry();
      iteratorRegistry.register({ ...iteratorHarness.factory, create: () => throwingIterator });
      const iteratorAdapter = (await iteratorRegistry.activate(
        iteratorHarness.factory.id,
        iteratorHarness.services
      ))!;
      expect(() => iteratorAdapter.metadata!.snapshot()).toThrowError(
        expect.objectContaining({ code: "malformed-response" })
      );
    });

    it("contains malformed events, progress, and throwing downstream callbacks", async () => {
      const harness = makeHarness();
      const connectionListeners = new Set<(value: unknown) => unknown>();
      const source = new Proxy(harness.adapter, {
        get: (target, property) => {
          if (property === "connection") {
            return {
              onDidChange: (listener: (value: unknown) => unknown) => {
                connectionListeners.add(listener);
                return { dispose: () => connectionListeners.delete(listener) };
              },
              label: "events",
              isConnected: () => Promise.resolve(true),
            };
          }
          if (property === "metadata") {
            return withMember(
              target.metadata!,
              "sync",
              (_scope: SyncScope, _signal?: AbortSignal, progress?: (value: unknown) => void) => {
                progress?.({ projectKey: "P", fetched: -1 });
                progress?.({ projectKey: "P", fetched: 1 });
                return Promise.resolve();
              }
            );
          }
          return Reflect.get(target, property, target);
        },
      });
      const warn = vi.spyOn(harness.services.logger, "warn");
      const registry = new TraceabilityAdapterRegistry();
      registry.register({ ...harness.factory, create: () => source });
      const adapter = (await registry.activate(harness.factory.id, harness.services))!;
      adapter.connection!.onDidChange(() => {throw new Error("listener boom");});

      expect(() => {
        for (const listener of connectionListeners) {
          listener("malformed");
          listener(undefined);
        }
      }).not.toThrow();
      await expect(adapter.metadata!.sync({}, undefined, () => {
        throw new Error("progress boom");
      })).resolves.toBeUndefined();
      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(4);
      await adapter.dispose?.();
      warn.mockRestore();
    });

    it("ignores retained progress callbacks after a successful operation", async () => {
      const harness = makeHarness();
      let retained: SyncProgress | undefined;
      const adapter = await activatedWithSync(harness, (_scope, _signal, progress) => {
        retained = progress;
        return Promise.resolve();
      });
      const observer = vi.fn();
      const warn = vi.spyOn(harness.services.logger, "warn");

      await adapter.metadata!.sync({}, undefined, observer);
      const warningCount = warn.mock.calls.length;

      expect(() => fireRetainedProgress(retained)).not.toThrow();
      expect(observer).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(warningCount);
      await adapter.dispose?.();
    });

    it("ignores retained progress callbacks after a failed operation", async () => {
      const harness = makeHarness();
      let retained: SyncProgress | undefined;
      const adapter = await activatedWithSync(harness, (_scope, _signal, progress) => {
        retained = progress;
        return Promise.reject(new Error("sync failed"));
      });
      const observer = vi.fn();
      const warn = vi.spyOn(harness.services.logger, "warn");

      await expect(adapter.metadata!.sync({}, undefined, observer)).rejects.toMatchObject({
        code: "provider-failed",
      });
      const warningCount = warn.mock.calls.length;

      expect(() => fireRetainedProgress(retained)).not.toThrow();
      expect(observer).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(warningCount);
      await adapter.dispose?.();
    });

    it("closes retained progress immediately on timeout-style cancellation", async () => {
      const harness = makeHarness();
      let retained: SyncProgress | undefined;
      const adapter = await activatedWithSync(harness, (_scope, signal, progress) => {
        retained = progress;
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        });
      });
      const observer = vi.fn();
      const warn = vi.spyOn(harness.services.logger, "warn");
      const controller = new AbortController();
      const operation = adapter.metadata!.sync({}, controller.signal, observer);

      controller.abort(new Error("timed out"));
      expect(() => fireRetainedProgress(retained)).not.toThrow();
      expect(observer).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      await expect(operation).rejects.toMatchObject({ code: "provider-failed" });
      await adapter.dispose?.();
    });

    it("closes retained progress on disposal before the provider settles", async () => {
      const harness = makeHarness();
      let retained: SyncProgress | undefined;
      let finish: (() => void) | undefined;
      const adapter = await activatedWithSync(harness, (_scope, _signal, progress) => {
        retained = progress;
        return new Promise<void>((resolve) => {finish = resolve;});
      });
      const observer = vi.fn();
      const warn = vi.spyOn(harness.services.logger, "warn");
      const operation = adapter.metadata!.sync({}, undefined, observer);

      await adapter.dispose?.();
      expect(() => fireRetainedProgress(retained)).not.toThrow();
      expect(observer).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      finish?.();
      await expect(operation).rejects.toMatchObject({ code: "adapter-disposed" });
    });

    it("gates concurrent operation progress independently", async () => {
      const harness = makeHarness();
      const retained: SyncProgress[] = [];
      const finish: Array<() => void> = [];
      const adapter = await activatedWithSync(harness, (_scope, _signal, progress) => {
        if (progress) {retained.push(progress);}
        return new Promise<void>((resolve) => {finish.push(resolve);});
      });
      const firstObserver = vi.fn();
      const secondObserver = vi.fn();
      const first = adapter.metadata!.sync({}, undefined, firstObserver);
      const second = adapter.metadata!.sync({}, undefined, secondObserver);

      retained[0]?.({ projectKey: "P", fetched: 1 });
      expect(firstObserver).toHaveBeenCalledOnce();
      finish[0]?.();
      await first;

      retained[0]?.({ projectKey: "P", fetched: 2 });
      retained[1]?.({ projectKey: "P", fetched: 1 });
      expect(firstObserver).toHaveBeenCalledOnce();
      expect(secondObserver).toHaveBeenCalledOnce();

      finish[1]?.();
      await second;
      retained[1]?.({ projectKey: "P", fetched: 2 });
      expect(secondObserver).toHaveBeenCalledOnce();
      await adapter.dispose?.();
    });

    it("bounds throwing and hung initialization and observes cancellation", async () => {
      const throwingHarness = makeHarness();
      const throwing = new Proxy(throwingHarness.adapter, {
        get: (target, property) => property === "initialize"
          ? () => Promise.reject(new Error("initialize boom"))
          : Reflect.get(target, property, target),
      });
      const throwingRegistry = new TraceabilityAdapterRegistry({ initializeTimeoutMs: 10 });
      throwingRegistry.register({ ...throwingHarness.factory, create: () => throwing });
      await expect(throwingRegistry.activate(
        throwingHarness.factory.id,
        throwingHarness.services
      )).rejects.toMatchObject({ code: "activation-failed" });

      const hungHarness = makeHarness();
      let timedOutSignal: AbortSignal | undefined;
      let finishLateInitialization: (() => void) | undefined;
      let timedOutDisposals = 0;
      const hung = new Proxy(hungHarness.adapter, {
        get: (target, property) => {
          if (property === "initialize") {
            return (signal: AbortSignal) => {
              timedOutSignal = signal;
              return new Promise<void>((resolve) => {finishLateInitialization = resolve;});
            };
          }
          if (property === "dispose") {
            return () => {timedOutDisposals += 1;};
          }
          return Reflect.get(target, property, target);
        },
      });
      const timeoutRegistry = new TraceabilityAdapterRegistry({ initializeTimeoutMs: 10 });
      timeoutRegistry.register({ ...hungHarness.factory, create: () => hung });
      await expect(timeoutRegistry.activate(
        hungHarness.factory.id,
        hungHarness.services
      )).rejects.toMatchObject({ code: "activation-timeout" });
      expect(timedOutSignal?.aborted).toBe(true);
      finishLateInitialization?.();
      await Promise.resolve();
      expect(timedOutDisposals).toBe(1);

      const cancelledHarness = makeHarness();
      let cancelledSignal: AbortSignal | undefined;
      const cancelled = new Proxy(cancelledHarness.adapter, {
        get: (target, property) => property === "initialize"
          ? (signal: AbortSignal) => {
              cancelledSignal = signal;
              return new Promise<void>(() => { /* deliberately unsettled */ });
            }
          : Reflect.get(target, property, target),
      });
      const cancellationRegistry = new TraceabilityAdapterRegistry({ initializeTimeoutMs: 100 });
      cancellationRegistry.register({ ...cancelledHarness.factory, create: () => cancelled });
      const controller = new AbortController();
      const activation = cancellationRegistry.activate(
        cancelledHarness.factory.id,
        cancelledHarness.services,
        controller.signal
      );
      controller.abort();
      await expect(activation).rejects.toMatchObject({ code: "activation-cancelled" });
      expect(cancelledSignal?.aborted).toBe(true);
    });

    it("bounds throwing and hung disposal", async () => {
      const throwingHarness = makeHarness();
      const throwing = new Proxy(throwingHarness.adapter, {
        get: (target, property) => property === "dispose"
          ? () => {throw new Error("dispose boom");}
          : Reflect.get(target, property, target),
      });
      const throwingRegistry = new TraceabilityAdapterRegistry({ disposeTimeoutMs: 10 });
      throwingRegistry.register({ ...throwingHarness.factory, create: () => throwing });
      const throwingAdapter = (await throwingRegistry.activate(
        throwingHarness.factory.id,
        throwingHarness.services
      ))!;
      await expect(throwingAdapter.dispose?.()).rejects.toMatchObject({ code: "disposal-failed" });

      const hungHarness = makeHarness();
      const hung = new Proxy(hungHarness.adapter, {
        get: (target, property) => property === "dispose"
          ? () => new Promise<void>(() => { /* deliberately unsettled */ })
          : Reflect.get(target, property, target),
      });
      const hungRegistry = new TraceabilityAdapterRegistry({ disposeTimeoutMs: 10 });
      hungRegistry.register({ ...hungHarness.factory, create: () => hung });
      const hungAdapter = (await hungRegistry.activate(hungHarness.factory.id, hungHarness.services))!;
      await expect(hungAdapter.dispose?.()).rejects.toMatchObject({ code: "disposal-timeout" });
    });

    it("ignores late events and results after disposal", async () => {
      const harness = makeHarness();
      const listeners = new Set<() => unknown>();
      let resolveConnected: ((value: boolean) => void) | undefined;
      const connected = new Promise<boolean>((resolve) => {resolveConnected = resolve;});
      const late = new Proxy(harness.adapter, {
        get: (target, property) => property === "connection"
          ? {
              onDidChange: (listener: () => unknown) => {
                listeners.add(listener);
                return { dispose: () => listeners.delete(listener) };
              },
              label: "late",
              isConnected: () => connected,
            }
          : Reflect.get(target, property, target),
      });
      const registry = new TraceabilityAdapterRegistry();
      registry.register({ ...harness.factory, create: () => late });
      const adapter = (await registry.activate(harness.factory.id, harness.services))!;
      let events = 0;
      adapter.connection?.onDidChange(() => {events += 1;});
      const result = adapter.connection!.isConnected();

      await adapter.dispose?.();
      resolveConnected?.(true);
      for (const listener of listeners) {listener();}

      await expect(result).rejects.toThrow(`Integration adapter "${harness.factory.id}" is disposed.`);
      expect(events).toBe(0);
    });

    it("extracts keys through its own grammar (no Jira assumptions)", async () => {
      const { adapter, grammarSample } = await activatedHarness(makeHarness);
      const extracted = extractKeys(grammarSample.tags, adapter.keyGrammar);
      expect(extracted.testKeys).toEqual(grammarSample.testKeys);
      expect(extracted.reqKeys).toEqual(grammarSample.reqKeys);
    });

    it("reports connection state and fires onDidChange on connect", async () => {
      const harness = await activatedHarness(makeHarness);
      const connection = harness.adapter.connection;
      expect(connection).toBeDefined();
      expect(await connection!.isConnected()).toBe(false);

      let fired = 0;
      const sub = connection!.onDidChange(() => { fired += 1; });
      await harness.connect();

      expect(await connection!.isConnected()).toBe(true);
      expect(fired).toBeGreaterThan(0);

      if (connection!.verify) {
        const result = await connection!.verify();
        expect(["ok", "auth-failed", "unreachable"]).toContain(result.status);
        expect(typeof result.message).toBe("string");
      }
      sub.dispose();
    });

    it("flags orphans and merges metadata on a complete catalogue fetch", async () => {
      const harness = await activatedHarness(makeHarness);
      await harness.connect();
      harness.seedCatalogue(
        [
          { key: harness.mappedKey, summary: "mapped test" },
          { key: harness.orphanKey, summary: "orphan test" },
        ],
        scopeProjects(harness)
      );
      await harness.adapter.metadata!.sync(harness.syncScope);

      const remote = harness.adapter.metadata!.snapshot();
      expect(remote.completeProjects.length).toBeGreaterThan(0);
      expect(remote.syncedAt).toBeTypeOf("number");

      const snap = join(harness);
      const mapped = snap.links.find((l) => l.testKey === harness.mappedKey);
      expect(mapped?.meta?.summary).toBe("mapped test");
      expect(snap.orphans.map((o) => o.testKey)).toEqual([harness.orphanKey]);
    });

    it("never derives orphans from a partial catalogue fetch", async () => {
      const harness = await activatedHarness(makeHarness);
      await harness.connect();
      harness.seedCatalogue([{ key: harness.mappedKey }, { key: harness.orphanKey }], []);
      await harness.adapter.metadata!.sync(harness.syncScope);

      const remote = harness.adapter.metadata!.snapshot();
      expect(remote.completeProjects).toEqual([]);
      expect(join(harness).orphans).toEqual([]);
    });

    // Completeness is per project: the project that landed keeps its orphans while the one that fell
    // short is simply left out, so one bad key in the scope can never blank the rest of the board.
    it("keeps the landed project's orphans when a sibling project falls short", async () => {
      const harness = await activatedHarness(makeHarness);
      const [landed, ...short] = scopeProjects(harness);
      expect(short.length).toBeGreaterThan(0);
      await harness.connect();
      harness.seedCatalogue([{ key: harness.mappedKey }, { key: harness.orphanKey }], [landed!]);
      await harness.adapter.metadata!.sync(harness.syncScope);

      const remote = harness.adapter.metadata!.snapshot();
      expect(remote.catalogueProjects).toEqual(expect.arrayContaining([...scopeProjects(harness)]));
      expect(remote.completeProjects).toEqual([landed]);
      expect(join(harness).orphans.map((o) => o.testKey)).toEqual([harness.orphanKey]);
    });

    it("records a sync error on the snapshot and suppresses orphans", async () => {
      const harness = await activatedHarness(makeHarness);
      await harness.connect();
      harness.seedCatalogue([{ key: harness.orphanKey }], scopeProjects(harness));
      harness.seedSyncError("transport failure");
      await harness.adapter.metadata!.sync(harness.syncScope);

      const remote = harness.adapter.metadata!.snapshot();
      expect(remote.errors).toContain("transport failure");
      expect(join(harness).orphans).toEqual([]);
    });

    // A later sync that learned nothing withdraws nothing: the catalogue on screen stays whole and the
    // stamp is what goes stale, so a transient outage never blanks a board that was already correct.
    it("keeps the prior catalogue whole when a later sync only errors", async () => {
      const harness = await activatedHarness(makeHarness);
      await harness.connect();
      harness.seedCatalogue(
        [{ key: harness.mappedKey }, { key: harness.orphanKey }],
        scopeProjects(harness)
      );
      await harness.adapter.metadata!.sync(harness.syncScope);
      const before = harness.adapter.metadata!.snapshot();

      harness.seedSyncError("transport failure");
      await harness.adapter.metadata!.sync(harness.syncScope);

      const after = harness.adapter.metadata!.snapshot();
      expect(after.completeProjects).toEqual(before.completeProjects);
      expect(after.catalogueProjects).toEqual(before.catalogueProjects);
      expect(after.fetchedScopes).toEqual(before.fetchedScopes);
      expect(after.syncedAt).toBe(before.syncedAt);
      expect(after.errors).toContain("transport failure");
      expect(join(harness).orphans.map((o) => o.testKey)).toEqual([harness.orphanKey]);
    });

    // A first sync that fetched nothing has no catalogue to present, so no surface may claim one:
    // "synced just now" over an unknown catalogue is the lie this rules out.
    it("leaves a wholly failed first sync unsynced", async () => {
      const harness = await activatedHarness(makeHarness);
      await harness.connect();
      harness.seedSyncError("transport failure");
      await harness.adapter.metadata!.sync(harness.syncScope);

      expect(harness.adapter.metadata!.snapshot().syncedAt).toBeUndefined();
    });

    it("resolves a browse link that carries the key", async () => {
      const { adapter, mappedKey } = await activatedHarness(makeHarness);
      const url = adapter.browseUrl({ key: mappedKey });
      expect(url).toBeDefined();
      expect(url).toContain(mappedKey);
    });

    it("publishes an artifact and returns a listed execution ref", async () => {
      const harness = await activatedHarness(makeHarness);
      await harness.connect();
      const publishing = harness.adapter.resultPublishing;
      expect(publishing).toBeDefined();

      const outcome = await publishing!.publish(harness.makeArtifact(), harness.publishRequest);
      expect(outcome.ref.kind).toBe("execution");
      expect(outcome.ref.key).toBeTruthy();

      const targets = await publishing!.searchTargets("execution", "");
      expect(targets.some((t) => t.ref.key === outcome.ref.key)).toBe(true);
    });

    // The kinds are distinct target spaces: a provider with no project concept answers empty, but
    // none may answer one kind with another kind's targets.
    it("never answers the project kind with execution targets", async () => {
      const harness = await activatedHarness(makeHarness);
      await harness.connect();
      const publishing = harness.adapter.resultPublishing!;
      await publishing.publish(harness.makeArtifact(), harness.publishRequest);

      const executions = await publishing.searchTargets("execution", "");
      const projects = await publishing.searchTargets("project", "");

      expect(executions.length).toBeGreaterThan(0);
      expect(projects.some((target) => executions.some((execution) => execution.ref.key === target.ref.key))).toBe(false);
    });
  });
}
