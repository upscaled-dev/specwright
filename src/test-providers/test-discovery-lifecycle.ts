interface CanonicalTicket { readonly version: number; }

interface ExactTicket {
  readonly capability: boolean;
  readonly key: string;
  readonly version: number;
}

/** Owns lazy canonical validity plus ordered, revocable presentation commits. */
export class TestDiscoveryLifecycle {
  private canonicalRequested = false;
  private canonicalEstablished = false;
  private canonicalValid = false;
  private canonicalVersion = 0;
  private disposed = false;
  private awaitingTrustRetry = false;
  private followUp = false;
  private running: Promise<boolean> | undefined;
  private commits: Promise<void> = Promise.resolve();
  private exactQueue: Promise<void> = Promise.resolve();
  private readonly latestExact = new Map<string, ExactTicket>();

  constructor(private readonly discover: () => Promise<boolean>) {}

  public get hasCanonicalSnapshot(): boolean {
    return this.canonicalValid;
  }

  public get hasCanonicalPresentation(): boolean {
    return this.canonicalEstablished;
  }

  public ensure(): Promise<boolean> {
    this.canonicalRequested = true;
    if (this.disposed) {return Promise.resolve(false);}
    if (!this.canonicalValid) {this.awaitingTrustRetry = false;}
    if (this.running) {return this.running;}
    return this.canonicalValid ? Promise.resolve(true) : this.start();
  }

  public refresh(): Promise<boolean> {
    this.canonicalRequested = true;
    this.markDirty();
    this.awaitingTrustRetry = false;
    return this.schedule();
  }

  /** A watcher invalidates authority once, then waits for a trust retry after a failed probe. */
  public invalidate(): Promise<boolean> {
    this.markDirty();
    return this.canonicalRequested && !this.awaitingTrustRetry ? this.schedule() : Promise.resolve(false);
  }

  public retireExact(): void {
    this.latestExact.clear();
  }

  public runExact<T>(
    key: string,
    capability: () => boolean,
    prepare: () => Promise<T>,
    apply: (value: T) => void
  ): Promise<void> {
    const ticket = this.beginExact(key, capability());
    const work = this.exactQueue.then(async () => {
      if (!this.isCurrentExact(ticket, capability)) {return;}
      const prepared = await prepare();
      if (!this.isCurrentExact(ticket, capability)) {return;}
      await this.commitExact(ticket, capability, () => apply(prepared));
    });
    this.exactQueue = work.catch(() => undefined);
    return work;
  }

  public beginCanonical(): CanonicalTicket {
    return { version: this.canonicalVersion };
  }

  public async commitCanonical(ticket: CanonicalTicket, apply: () => void): Promise<boolean> {
    return this.commit(() => !this.disposed && ticket.version === this.canonicalVersion, apply);
  }

  public retryAfterTrustGrant(): Promise<boolean> {
    if (!this.canonicalRequested || this.canonicalValid) {return Promise.resolve(false);}
    this.awaitingTrustRetry = false;
    return this.schedule();
  }

  public dispose(): void {
    this.disposed = true;
    this.markDirty();
    this.latestExact.clear();
  }

  private beginExact(key: string, capability: boolean): ExactTicket {
    this.markDirty();
    if (this.running && !this.awaitingTrustRetry) {this.followUp = true;}
    const ticket = { key, capability, version: (this.latestExact.get(key)?.version ?? 0) + 1 };
    this.latestExact.set(key, ticket);
    return ticket;
  }

  private async commitExact(
    ticket: ExactTicket,
    capability: () => boolean,
    apply: () => void
  ): Promise<boolean> {
    return this.commit(() => this.isCurrentExact(ticket, capability), apply);
  }

  private async commit(isCurrent: () => boolean, apply: () => void): Promise<boolean> {
    const committed = this.commits.then(() => {
      if (!isCurrent()) {return false;}
      apply();
      return true;
    });
    this.commits = committed.then(() => undefined, () => undefined);
    return committed;
  }

  private markDirty(): void {
    this.canonicalValid = false;
    this.canonicalVersion += 1;
  }

  private isCurrentExact(ticket: ExactTicket, capability: () => boolean): boolean {
    return !this.disposed
      && this.latestExact.get(ticket.key) === ticket
      && ticket.capability
      && capability();
  }

  private schedule(): Promise<boolean> {
    if (this.disposed) {return Promise.resolve(false);}
    if (this.running) {
      this.followUp = true;
      return this.running;
    }
    return this.start();
  }

  private start(): Promise<boolean> {
    let settle!: (value: boolean) => void;
    this.running = new Promise<boolean>((resolve) => {settle = resolve;});
    queueMicrotask(() => {
      this.drain().then(settle, () => settle(false));
    });
    this.running.finally(() => {this.running = undefined;}).catch(() => { /* settled above */ });
    return this.running;
  }

  private async drain(): Promise<boolean> {
    let valid = false;
    do {
      this.followUp = false;
      try {valid = !this.disposed && (await this.discover()) && !this.disposed;}
      catch {valid = false;}
      this.canonicalValid = valid;
      this.canonicalEstablished = this.canonicalEstablished || valid;
      // A failed pass made stale by a queued invalidation is not terminal. Trust-wait suppression
      // applies only after the final pass settles, so another event during a follow-up can queue again.
      this.awaitingTrustRetry = this.followUp ? false : !valid;
    } while (!this.disposed && this.followUp);
    return this.canonicalValid;
  }
}
