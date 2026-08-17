import type * as vscode from "vscode";
import {
  WEBVIEW_PROTOCOL_VERSION,
  type SetupClientMessage,
  type SetupEnvelope,
  type SetupHostMessage,
  type SetupRegion,
} from "../webview/setup-protocol";
import { XraySetupViewState } from "./xray-setup-view-state";

const PENDING_DOCUMENT_LIMIT = 32;
const RETIRED_DOCUMENT_LIMIT = 64;

interface InitialView {
  readonly site: string;
  readonly region: SetupRegion;
  readonly credentials: boolean;
  readonly jira: boolean;
}

interface DocumentLink {
  readonly document: string;
  readonly previous: string;
  readonly sequence: number;
}

interface ReachableDocuments {
  readonly path: readonly string[];
  readonly documents: ReadonlySet<string>;
}

/** Owns one setup panel's versioned document channel and reloadable host projection. */
export class XraySetupChannel {
  private readonly view: XraySetupViewState;
  private readonly pending = new Map<string, DocumentLink>();
  private readonly retired = new Set<string>();
  private readonly retiredOrder: string[] = [];
  private activeDocument: string | undefined;
  private delivery: Promise<void> = Promise.resolve();
  private hydrationTask: Promise<void> | undefined;
  private generation = 0;
  private requestedGeneration = 0;
  private attemptedGeneration = 0;
  private hydratedGeneration = 0;
  private retryRequestedGeneration = 0;
  private linkSequence = 0;
  private revision = 0;
  private acknowledgedRevision = 0;
  private disposed = false;

  public constructor(
    private readonly webview: vscode.Webview,
    private readonly session: string,
    private readonly available: () => boolean,
    initial: InitialView
  ) {
    this.view = new XraySetupViewState(
      initial.site,
      initial.region,
      initial.credentials,
      initial.jira
    );
  }

  public accepts(envelope: SetupEnvelope<SetupClientMessage>): boolean {
    return this.matches(envelope) && this.canMutate();
  }

  public canMutate(): boolean {
    return this.activeDocument !== undefined && this.isAvailable() &&
      this.hydratedGeneration === this.generation;
  }

  public recover(envelope: SetupEnvelope<SetupClientMessage>): Promise<void> {
    return this.matchesAcknowledged(envelope) &&
      this.hydratedGeneration !== this.generation && this.isAvailable()
      ? this.requestHydration(true)
      : Promise.resolve();
  }

  public rehydrate(): Promise<void> {
    return !this.disposed && this.hydratedGeneration !== this.generation && this.isAvailable()
      ? this.requestHydration(true)
      : Promise.resolve();
  }

  public hydrate(document: string, previousDocument: string | undefined): Promise<void> {
    if (this.disposed || this.retired.has(document)) {return Promise.resolve();}
    if (document === this.activeDocument) {
      return this.hydratedGeneration === this.generation
        ? Promise.resolve()
        : this.requestHydration(true);
    }
    if (previousDocument === undefined) {
      return this.activeDocument === undefined
        ? this.activateReachable(document)
        : Promise.resolve();
    }
    if (document === previousDocument || this.retired.has(previousDocument)) {return Promise.resolve();}
    if (!this.rememberLink(document, previousDocument)) {return Promise.resolve();}
    if (this.activeDocument === undefined) {return Promise.resolve();}

    const reachable = this.reachableFrom(this.activeDocument);
    return reachable.path.length > 1 ? this.activate(reachable) : Promise.resolve();
  }

  public async post(message: SetupHostMessage, retain = true): Promise<boolean> {
    if (this.disposed) {return false;}
    this.view.apply(message, retain);
    const document = this.activeDocument;
    const generation = this.generation;
    if (document !== undefined) {
      const delivered = await this.deliver(message, document, generation);
      if (!delivered && document === this.activeDocument && generation === this.generation) {
        this.hydratedGeneration = Math.min(this.hydratedGeneration, generation - 1);
      }
      return delivered;
    }
    return false;
  }

  public dispose(): Promise<void> {
    this.disposed = true;
    const pending = [this.delivery, ...(this.hydrationTask ? [this.hydrationTask] : [])];
    return Promise.allSettled(pending).then(() => undefined);
  }

  private rememberLink(document: string, previous: string): boolean {
    if (this.pending.has(document)) {return false;}
    if (this.pending.size === PENDING_DOCUMENT_LIMIT) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest !== undefined) {this.pending.delete(oldest);}
    }
    this.pending.set(document, { document, previous, sequence: ++this.linkSequence });
    return true;
  }

  private activateReachable(root: string): Promise<void> {
    return this.activate(this.reachableFrom(root));
  }

  private reachableFrom(root: string): ReachableDocuments {
    const visited = new Set([root]);
    const parents = new Map<string, string>();
    const queue = [root];
    const reachable: DocumentLink[] = [];
    const withChildren = new Set<string>();
    for (let index = 0; index < queue.length; index += 1) {
      const previous = queue[index];
      if (previous === undefined) {break;}
      for (const candidate of this.pending.values()) {
        if (candidate.previous !== previous || visited.has(candidate.document)) {continue;}
        visited.add(candidate.document);
        parents.set(candidate.document, previous);
        queue.push(candidate.document);
        reachable.push(candidate);
        withChildren.add(previous);
      }
    }
    // A known successor makes its ancestor ineligible even when the ancestor's ready arrived later.
    const leaves = reachable.filter((candidate) => !withChildren.has(candidate.document));
    let newest: DocumentLink | undefined;
    for (const candidate of leaves) {
      if (newest === undefined || candidate.sequence > newest.sequence) {newest = candidate;}
    }
    const path = [newest?.document ?? root];
    while (path[0] !== root) {
      const current = path[0];
      if (current === undefined) {return { path: [root], documents: visited };}
      const previous = parents.get(current);
      if (previous === undefined) {return { path: [root], documents: visited };}
      path.unshift(previous);
    }
    return { path, documents: visited };
  }

  private activate(reachable: ReachableDocuments): Promise<void> {
    const newest = reachable.path.at(-1);
    if (newest === undefined || newest === this.activeDocument) {return Promise.resolve();}
    for (const document of reachable.documents) {
      if (document !== newest) {this.rememberRetired(document);}
    }
    this.activeDocument = newest;
    this.acknowledgedRevision = 0;
    this.generation += 1;
    this.requestedGeneration = this.generation;
    this.prunePending();
    return this.requestHydration();
  }

  private rememberRetired(document: string): void {
    if (this.retired.has(document)) {return;}
    this.retired.add(document);
    this.retiredOrder.push(document);
    if (this.retiredOrder.length > RETIRED_DOCUMENT_LIMIT) {
      const oldest = this.retiredOrder.shift();
      if (oldest !== undefined) {this.retired.delete(oldest);}
    }
  }

  private prunePending(): void {
    for (const [document, link] of this.pending) {
      if (this.retired.has(document) || this.retired.has(link.previous) || document === this.activeDocument) {
        this.pending.delete(document);
      }
    }
  }

  private requestHydration(retryIfRunning = false): Promise<void> {
    if (this.hydrationTask !== undefined) {
      if (retryIfRunning) {this.retryRequestedGeneration = this.generation;}
      return this.hydrationTask;
    }
    const task = this.runHydration();
    this.hydrationTask = task;
    task.finally(() => {
      if (this.hydrationTask === task) {this.hydrationTask = undefined;}
      if (!this.disposed && this.requestedGeneration !== this.attemptedGeneration) {
        this.requestHydration().catch(() => undefined);
      }
    }).catch(() => undefined);
    return task;
  }

  private async runHydration(): Promise<void> {
    // One turn coalesces a rapid successor chain before any snapshot becomes ready to post.
    await Promise.resolve();
    let retriedGeneration = 0;
    while (!this.disposed) {
      const document = this.activeDocument;
      const generation = this.requestedGeneration;
      if (document === undefined) {return;}
      const deliveries = this.view.snapshot().map((message) =>
        this.deliver(message, document, generation)
      );
      const delivered = await Promise.all(deliveries);
      this.attemptedGeneration = generation;
      const succeeded =
        delivered.every(Boolean) &&
        document === this.activeDocument && generation === this.generation;
      if (succeeded) {
        this.hydratedGeneration = generation;
      }
      const retry = !succeeded && generation === this.requestedGeneration &&
        this.retryRequestedGeneration === generation && retriedGeneration !== generation;
      if (this.retryRequestedGeneration === generation) {this.retryRequestedGeneration = 0;}
      if (retry) {
        retriedGeneration = generation;
        continue;
      }
      if (generation === this.requestedGeneration) {return;}
      retriedGeneration = 0;
    }
  }

  private deliver(message: SetupHostMessage, document: string, generation: number): Promise<boolean> {
    const envelope: SetupEnvelope<SetupHostMessage> = {
      version: WEBVIEW_PROTOCOL_VERSION,
      session: this.session,
      document,
      revision: ++this.revision,
      surface: "setup",
      body: message,
    };
    const task = this.delivery.then(async () => {
      try {
        if (
          !this.isAvailable() ||
          document !== this.activeDocument || generation !== this.generation
        ) {return false;}
        const delivered = await Promise.resolve(this.webview.postMessage(envelope)) === true;
        if (
          delivered && document === this.activeDocument && generation === this.generation
        ) {
          this.acknowledgedRevision = envelope.revision;
        }
        return delivered;
      } catch {
        return false;
      }
    });
    this.delivery = task.then(() => undefined, () => undefined);
    return task;
  }

  private matches(envelope: SetupEnvelope<SetupClientMessage>): boolean {
    return envelope.document === this.activeDocument && envelope.revision === this.revision;
  }

  private matchesAcknowledged(envelope: SetupEnvelope<SetupClientMessage>): boolean {
    return envelope.document === this.activeDocument &&
      envelope.revision === this.acknowledgedRevision;
  }

  private isAvailable(): boolean {
    try {
      return !this.disposed && this.available();
    } catch {
      return false;
    }
  }
}
