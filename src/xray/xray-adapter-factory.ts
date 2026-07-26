import type { Memento } from "vscode";
import { ConnectionVerifyResult, TestAuthoringCapability } from "../traceability/contracts";
import { TraceabilityAdapterFactory } from "../traceability/adapter-registry";
import { canonicalizeXrayKey, normalizeSiteUrl, XrayAdapter } from "./xray-adapter";
import { XrayClient } from "./xray-client";
import { XrayMetadataCapability } from "./xray-metadata";
import { currentWorkspaceId, XrayMetadataCache } from "./xray-metadata-cache";
import { parseXrayRegion, xrayBaseUrl } from "./xray-region";
import { XrayCredentialStore } from "./xray-credential-store";
import type { XrayConnectionOutcome, XrayProbe } from "./xray-connection-test";
import { StepResolver } from "./execution-importers";
import { createXrayResultPublishing } from "./xray-result-publishing";

// The extension-side wiring the publish capability's create path needs: resolve a scenario's current
// step text (FeatureParser) and the owning workspace root for the cucumber `uri` relativization.
export interface XrayPublishSupport {
  resolveSteps: StepResolver;
  workspaceRootFor: (filePath: string) => string | undefined;
}

// An auth-only probe can only land in the ok/auth/network stages: ok is a verified handshake,
// network means the site was unreachable, and every other stage is an authentication failure.
function toVerifyResult(outcome: XrayConnectionOutcome): ConnectionVerifyResult {
  if (outcome.ok) {
    return { status: "ok", message: outcome.message };
  }
  if (outcome.stage === "network") {
    return { status: "unreachable", message: outcome.message };
  }
  return { status: "auth-failed", message: outcome.message };
}

/**
 * Wires the Xray adapter's live capabilities: the region-aware client, the namespaced persistent
 * cache, and the metadata capability. Kept out of `xray-adapter.ts` so the connection-test module
 * (which the client's allowlist helpers live in) never forms an import cycle with the adapter.
 * `probe` and `memento` are injected the same way the verify probe went in.
 */
export function createXrayAdapterFactory(
  credentialStore: XrayCredentialStore,
  probe: XrayProbe,
  memento: Memento,
  publishSupport: XrayPublishSupport
): TraceabilityAdapterFactory {
  return {
    id: "xray",
    create: (ctx) => {
      const region = parseXrayRegion(ctx.config.xrayApiRegion);
      const verify = (): Promise<ConnectionVerifyResult> =>
        probe(
          {
            site: ctx.config.xraySiteUrl,
            region,
            credentialStore,
            logger: ctx.logger,
            knownTestKeys: () => [],
          },
          { authOnly: true }
        ).then(toVerifyResult);
      const client = new XrayClient({
        region,
        logger: ctx.logger,
        credentials: () => credentialStore.getCredentials(ctx.config.xraySiteUrl),
      });
      // Account = the non-secret client id, read from SecretStorage per §7 (never a hashed secret).
      const account = async (): Promise<string | undefined> =>
        (await credentialStore.getCredentials(ctx.config.xraySiteUrl))?.clientId;
      const cache = new XrayMetadataCache(memento, {
        endpoint: new URL(xrayBaseUrl(region)).host,
        account,
        workspaceId: currentWorkspaceId(),
      });
      const metadata = new XrayMetadataCapability({
        client,
        cache,
        config: ctx.config,
        logger: ctx.logger,
        account,
        // Every credential change drops the JWT and re-stamps/reloads state for the current account,
        // so a same-site account switch never serves the prior account's data.
        onCredentialsChange: credentialStore.onDidChange,
        canonicalizeKey: canonicalizeXrayKey,
      });
      const resultPublishing = createXrayResultPublishing({
        transport: client,
        site: () => normalizeSiteUrl(ctx.config.xraySiteUrl),
        jiraCredentials: () => credentialStore.getJiraCredentials(ctx.config.xraySiteUrl),
        resolveSteps: publishSupport.resolveSteps,
        workspaceRootFor: publishSupport.workspaceRootFor,
        attachTo: () => ctx.config.xrayAttachTo,
        logger: ctx.logger,
      });
      // A thin wrapper over the client's authoring mutations, with no cache/account state: each one
      // reads its result back inline and the subsequent `mergeKeys` (on the metadata capability) owns
      // persistence and its account guards.
      const testAuthoring: TestAuthoringCapability = {
        createTest: (spec, signal) => client.createTest(spec, signal),
        pushGherkin: (issueId, gherkin, signal) => client.updateGherkinTestDefinition(issueId, gherkin, signal),
      };
      // The capability implements both metadata and remote search over the same client/state, so it
      // fills both adapter slots — the linkScenario picker's remote-search section is thereby gated on
      // the live (synced) adapter, never the browse-only instance. Authoring rides the same live
      // client, so the "create a new test" entry is gated the same way.
      return new XrayAdapter(ctx.config, credentialStore, verify, metadata, metadata, resultPublishing, testAuthoring);
    },
  };
}
