import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { XraySetupChannel } from "../../xray/xray-setup-channel";
import type {
  SetupClientMessage,
  SetupEnvelope,
  SetupHostMessage,
} from "../../webview/setup-protocol";

type HostEnvelope = SetupEnvelope<SetupHostMessage>;

function documentId(value: number): string {
  return value.toString(16).padStart(32, "0");
}

function channelWith(
  postMessage: (message: HostEnvelope) => Promise<boolean> = () => Promise.resolve(true),
  available: () => boolean = () => true
): { channel: XraySetupChannel; posted: HostEnvelope[] } {
  const posted: HostEnvelope[] = [];
  const webview = {
    postMessage: (message: HostEnvelope): Promise<boolean> => {
      posted.push(message);
      return postMessage(message);
    },
  } as unknown as vscode.Webview;
  return {
    channel: new XraySetupChannel(webview, "session", available, {
      site: "acme.atlassian.net",
      region: "global",
      credentials: false,
      jira: false,
    }),
    posted,
  };
}

function saveEnvelope(document: string, revision: number): SetupEnvelope<SetupClientMessage> {
  return {
    version: 1,
    session: "session",
    document,
    revision,
    surface: "setup",
    body: {
      type: "save",
      site: "acme.atlassian.net",
      region: "global",
      clientId: "id",
      clientSecret: "secret",
      jiraEmail: "",
      jiraToken: "",
      test: false,
    },
  };
}

describe("XraySetupChannel", () => {
  it("resolves C-before-B and hydrates only the newest reachable document", async () => {
    const { channel, posted } = channelWith();
    const [a, b, c] = [documentId(1), documentId(2), documentId(3)] as const;
    await channel.hydrate(a, undefined);
    posted.length = 0;

    await channel.hydrate(c, b);
    expect(posted).toEqual([]);
    await channel.hydrate(b, a);

    expect(posted).toHaveLength(3);
    expect(posted.every((message) => message.document === c)).toBe(true);
    expect(channel.accepts(saveEnvelope(c, posted.at(-1)!.revision))).toBe(true);
    await channel.dispose();
  });

  it("selects the globally newest reachable document instead of the newest immediate child", async () => {
    const { channel, posted } = channelWith();
    const [a, b, c, d] = [documentId(1), documentId(2), documentId(3), documentId(4)] as const;

    await channel.hydrate(b, a); // sequence 1
    await channel.hydrate(d, a); // sequence 2
    await channel.hydrate(c, b); // sequence 3
    await channel.hydrate(a, undefined);

    expect(posted).toHaveLength(3);
    expect(posted.every((message) => message.document === c)).toBe(true);
    await channel.hydrate(d, a);
    expect(posted).toHaveLength(3);
    await channel.dispose();
  });

  it("bounds branches and guards a reachable cycle", async () => {
    const { channel, posted } = channelWith();
    const root = documentId(1);
    await channel.hydrate(documentId(2), root);
    await channel.hydrate(root, documentId(2));
    for (let index = 3; index <= 32; index += 1) {
      await channel.hydrate(documentId(index), root);
    }

    await channel.hydrate(root, undefined);

    expect(posted).toHaveLength(3);
    expect(posted.every((message) => message.document === documentId(32))).toBe(true);
    await channel.dispose();
  });

  it("coalesces a rapid successor flood to one bounded newest-document snapshot", async () => {
    const { channel, posted } = channelWith();
    let previous = documentId(1);
    await channel.hydrate(previous, undefined);
    posted.length = 0;

    const hydrations: Promise<void>[] = [];
    for (let index = 2; index <= 101; index++) {
      const document = documentId(index);
      hydrations.push(channel.hydrate(document, previous));
      previous = document;
    }
    await Promise.all(hydrations);

    expect(posted).toHaveLength(3);
    expect(posted.every((message) => message.document === documentId(101))).toBe(true);
    expect(channel.accepts(saveEnvelope(documentId(101), posted.at(-1)!.revision))).toBe(true);
    await channel.dispose();
  });

  it("suppresses queued deliveries as soon as their document is retired", async () => {
    let release!: (value: boolean) => void;
    const firstPost = new Promise<boolean>((resolve) => {release = resolve;});
    let calls = 0;
    const { channel, posted } = channelWith(() => ++calls === 1 ? firstPost : Promise.resolve(true));
    const [a, b] = [documentId(1), documentId(2)] as const;
    const firstHydration = channel.hydrate(a, undefined);
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    const successorHydration = channel.hydrate(b, a);
    release(true);
    await Promise.all([firstHydration, successorHydration]);

    expect(posted.filter((message) => message.document === a)).toHaveLength(1);
    expect(posted.filter((message) => message.document === b)).toHaveLength(3);
    await channel.dispose();
  });

  it.each(["false", "reject", "throw"] as const)(
    "retries an unhydrated active document after a final post %s without amplifying",
    async (failure) => {
      let calls = 0;
      const { channel, posted } = channelWith(() => {
        calls += 1;
        if (calls !== 3) {return Promise.resolve(true);}
        if (failure === "false") {return Promise.resolve(false);}
        if (failure === "reject") {return Promise.reject(new Error("delivery failed"));}
        throw new Error("delivery failed");
      });
      const document = documentId(1);

      await channel.hydrate(document, undefined);
      await Promise.resolve();
      expect(posted).toHaveLength(3);
      expect(channel.accepts(saveEnvelope(document, posted.at(-1)!.revision))).toBe(false);

      await channel.hydrate(document, undefined);
      expect(posted).toHaveLength(6);
      expect(channel.accepts(saveEnvelope(document, posted.at(-1)!.revision))).toBe(true);
      await channel.dispose();
    }
  );

  it.each([
    ["cancels the demand when the first attempt succeeds", true, true, 3, true],
    ["runs one follow-up when the first attempt fails", false, true, 6, true],
    ["stops after one failing follow-up", false, false, 6, false],
  ] as const)(
    "%s for many duplicate ready messages during hydration",
    async (_label, firstSucceeds, retrySucceeds, expectedPosts, accepted) => {
      let release!: (value: boolean) => void;
      const first = new Promise<boolean>((resolve) => {release = resolve;});
      let calls = 0;
      const { channel, posted } = channelWith(() => {
        calls += 1;
        if (calls === 1) {return first;}
        if (calls === 6) {return Promise.resolve(retrySucceeds);}
        return Promise.resolve(true);
      });
      const document = documentId(1);
      const hydration = channel.hydrate(document, undefined);
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      const duplicates = Array.from({ length: 20 }, () => channel.hydrate(document, undefined));

      release(firstSucceeds);
      await Promise.all([hydration, ...duplicates]);
      await Promise.resolve();

      expect(posted).toHaveLength(expectedPosts);
      expect(channel.accepts(saveEnvelope(document, posted.at(-1)!.revision))).toBe(accepted);
      await channel.dispose();
    }
  );

  it("retries once when availability returns and replays retained ordinary post failures", async () => {
    let available = false;
    let failNext = false;
    const { channel, posted } = channelWith(
      () => Promise.resolve(failNext ? (failNext = false) : true),
      () => available
    );
    const document = documentId(1);

    await channel.hydrate(document, undefined);
    expect(posted).toEqual([]);
    available = true;
    await channel.hydrate(document, undefined);
    expect(posted).toHaveLength(3);
    const acknowledgedRevision = posted.at(-1)!.revision;

    failNext = true;
    await channel.post({ type: "conn-state", state: "connected", label: "Connected" });
    expect(channel.accepts(saveEnvelope(document, posted.at(-1)!.revision))).toBe(false);
    const beforeRecovery = posted.length;
    await channel.recover(saveEnvelope(document, acknowledgedRevision - 1));
    await channel.recover(saveEnvelope(document, posted.at(-1)!.revision));
    await channel.recover(saveEnvelope(documentId(9), acknowledgedRevision));
    expect(posted).toHaveLength(beforeRecovery);
    await channel.recover(saveEnvelope(document, acknowledgedRevision));

    expect(posted).toHaveLength(7);
    expect(posted.slice(-3).map((message) => message.body)).toContainEqual({
      type: "conn-state",
      state: "connected",
      label: "Connected",
    });
    expect(channel.accepts(saveEnvelope(document, posted.at(-1)!.revision))).toBe(true);
    await channel.dispose();
  });

  it("retains view changes posted during temporary unavailability", async () => {
    let available = true;
    const { channel, posted } = channelWith(() => Promise.resolve(true), () => available);
    const document = documentId(1);
    await channel.hydrate(document, undefined);
    posted.length = 0;

    available = false;
    await channel.post({ type: "conn-state", state: "connected", label: "Connected while hidden" });
    expect(posted).toEqual([]);
    available = true;
    await channel.hydrate(document, undefined);

    expect(posted).toHaveLength(3);
    expect(posted.map((message) => message.body)).toContainEqual({
      type: "conn-state",
      state: "connected",
      label: "Connected while hidden",
    });
    expect(channel.accepts(saveEnvelope(document, posted.at(-1)!.revision))).toBe(true);
    await channel.dispose();
  });

  it("drains an admitted delivery during disposal without starting queued work", async () => {
    let release!: (value: boolean) => void;
    const admitted = new Promise<boolean>((resolve) => {release = resolve;});
    const { channel, posted } = channelWith(() => admitted);
    const hydration = channel.hydrate(documentId(1), undefined);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    let drained = false;
    const disposal = channel.dispose().then(() => {drained = true;});
    await Promise.resolve();
    expect(drained).toBe(false);

    release(true);
    await Promise.all([hydration, disposal]);
    expect(posted).toHaveLength(1);
    expect(drained).toBe(true);
  });

  it("keeps duplicate, replayed, retired-root, and foreign-root ready messages inert", async () => {
    const { channel, posted } = channelWith();
    const [a, b, foreign] = [documentId(1), documentId(2), documentId(9)] as const;
    await channel.hydrate(a, undefined);
    await channel.hydrate(b, a);
    posted.length = 0;

    await channel.hydrate(b, a);
    await channel.hydrate(a, undefined);
    await channel.hydrate(foreign, undefined);
    await channel.hydrate(documentId(10), a);

    expect(posted).toEqual([]);
    await channel.dispose();
  });

  it("delivers validation once but omits it from a successor snapshot", async () => {
    const { channel, posted } = channelWith();
    const [a, b] = [documentId(1), documentId(2)] as const;
    await channel.hydrate(a, undefined);
    await channel.post({ type: "validation", errors: { site: "Enter a site" } }, false);
    expect(posted.at(-1)?.body.type).toBe("validation");
    posted.length = 0;

    await channel.hydrate(b, a);

    expect(posted.map((message) => message.body.type)).toEqual([
      "form-state",
      "conn-state",
      "busy",
    ]);
    await channel.dispose();
  });
});
