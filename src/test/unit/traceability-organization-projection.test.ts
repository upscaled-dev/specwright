import { describe, expect, it } from "vitest";
import {
  REPOSITORY_FOLDER_DEPTH_LIMIT,
  REPOSITORY_FOLDER_NODE_LIMIT,
  projectTraceabilityOrganization,
  resolveRepositoryFolderPreview,
} from "../../traceability/traceability-organization-projection";
import type { OrganizationProjection } from "../../traceability/traceability-organization-projection";
import type { OrganizationSnapshot } from "../../traceability/contracts";
import { ORGANIZATION_ITEM_LIMIT } from "../../traceability/contracts";
import type { TraceabilitySnapshot } from "../../traceability/traceability-model";

const scenario = { filePath: "/ws/a.feature", line: 3, name: "Mapped", kind: "scenario" as const };
const mapped: TraceabilitySnapshot = {
  links: [{ testKey: "SHOP-1", scenario, reqKeys: [] }],
  untraced: [], orphans: [], stale: false, completeProjects: ["SHOP"], errors: [],
};

function organization(over: Partial<OrganizationSnapshot> = {}): OrganizationSnapshot {
  return { repositories: [], testSetProjects: [], stale: false, omittedTestSetProjectCount: 0, omittedRepositoryProjectCount: 0, ...over };
}

function folderRows(projection: OrganizationProjection): { path: string; description: string | undefined }[] {
  return projection.rows.filter((row) => row.icon === "folder-library").map((row) => {
    const node = projection.nodes.get(row.id);
    return { path: node?.kind === "repositoryFolder" ? node.folderPath : row.label, description: row.description };
  });
}

function repository(tests: OrganizationSnapshot["repositories"][number]["tests"]): OrganizationSnapshot {
  return organization({ repositories: [{ projectKey: "SHOP", tests, complete: true, truncated: false, errors: [] }] });
}

describe("traceability organization projection", () => {
  it("emits each folder's tests directly under their own folder row", () => {
    const snapshot = organization({ repositories: [{
      projectKey: "SHOP",
      tests: [
        { key: "SHOP-2", repositoryFolder: { name: "B", path: "/B" } },
        { key: "SHOP-1", repositoryFolder: { name: "A", path: "/A" } },
      ],
      complete: true, truncated: false, errors: [],
    }] });

    const rows = projectTraceabilityOrganization(snapshot, mapped).rows.filter((row) => row.view === "repository");

    expect(rows.map((row) => row.label)).toEqual(["SHOP", "A", "SHOP-1", "B", "SHOP-2"]);
    expect(rows[2]?.parentId).toBe(rows[1]?.id);
    expect(rows[4]?.parentId).toBe(rows[3]?.id);
  });

  it("keeps a folder named Unfiled apart from the tests that sit in no folder", () => {
    const snapshot = repository([
      { key: "SHOP-1", repositoryFolder: { name: "Unfiled", path: "/Unfiled" } },
      { key: "SHOP-2" },
      { key: "SHOP-3", repositoryFolder: { name: "Zebra", path: "/Zebra" } },
    ]);

    const projection = projectTraceabilityOrganization(snapshot, mapped);

    // The bucket of unfoldered tests sorts after every real folder, not where its key's punctuation
    // happens to land it.
    expect(folderRows(projection)).toEqual([
      { path: "/Unfiled", description: "1 remote tests · 1 mapped locally" },
      { path: "/Zebra", description: "1 remote tests · 0 mapped locally" },
      { path: "Unfiled", description: "1 remote tests · 0 mapped locally" },
    ]);
    expect(projection.rows.filter((row) => row.icon === "folder-library").map((row) => row.label))
      .toEqual(["Unfiled", "Zebra", "Unfiled"]);
    expect(resolveRepositoryFolderPreview(snapshot, mapped, "SHOP", "/Unfiled")?.members.map((member) => member.label))
      .toEqual(["SHOP-1"]);
  });

  it("resolves traversal and empty segments to the folder key the clean path would take", () => {
    const snapshot = repository([
      { key: "SHOP-1", repositoryFolder: { name: "B", path: "/A/B" } },
      { key: "SHOP-2", repositoryFolder: { name: "B", path: "A/./B" } },
      { key: "SHOP-3", repositoryFolder: { name: "B", path: "A//B\\" } },
      { key: "SHOP-4", repositoryFolder: { name: "B", path: "A/../B" } },
    ]);

    expect(folderRows(projectTraceabilityOrganization(snapshot, mapped))).toEqual([
      { path: "/A", description: "3 remote tests · 1 mapped locally" },
      { path: "/A/B", description: "3 remote tests · 1 mapped locally" },
      { path: "/B", description: "1 remote tests · 0 mapped locally" },
    ]);
  });

  it("scopes a folder run to that folder, not to a sibling whose name it prefixes", () => {
    const snapshot = repository([
      { key: "SHOP-1", repositoryFolder: { name: "A", path: "/A" } },
      { key: "SHOP-2", repositoryFolder: { name: "AB", path: "/AB" } },
    ]);

    expect(resolveRepositoryFolderPreview(snapshot, mapped, "SHOP", "/A")?.members.map((member) => member.label))
      .toEqual(["SHOP-1"]);
  });
});

describe("traceability organization projection bounds", () => {
  it("shows only loaded membership facts when a Test Set is incomplete", () => {
    const result = projectTraceabilityOrganization(organization({
      testSetProjects: [{
        projectKey: "SHOP", complete: true, truncated: false, errors: [],
        testSets: [{
          key: "SHOP-301", issueId: "301", members: Array.from({ length: 50 }, (_, index) => ({ key: `SHOP-${index + 1}` })),
          remoteMemberCount: 100, membershipComplete: false, truncated: true, errors: ["membership incomplete"],
        }],
      }],
    }), mapped);
    const row = result.rows.find((candidate) => candidate.label === "SHOP-301");

    expect(row?.description).toContain("100 remote members · 50 loaded · membership incomplete");
    expect(row?.description).not.toContain("runnable locally");
    expect(row?.description).not.toContain("remote only");
  });

  it("caps amplified folder hierarchies and advertises no run from a truncated project", () => {
    const tests = Array.from({ length: REPOSITORY_FOLDER_NODE_LIMIT + 1 }, (_, index) => ({
      key: `SHOP-${index + 1}`, repositoryFolder: { name: `F${index}`, path: `/F${index}` },
    }));
    const snapshot = organization({
      repositories: [{ projectKey: "SHOP", tests, complete: true, truncated: false, errors: [] }],
    });

    const result = projectTraceabilityOrganization(snapshot, mapped);
    const folders = result.rows.filter((row) => row.icon === "folder-library");

    expect(folders).toHaveLength(REPOSITORY_FOLDER_NODE_LIMIT);
    expect(result.rows.find((row) => row.label === "SHOP")?.description).toContain("hierarchy truncated");
    expect(folders.every((row) => row.actions.every((action) => action.id !== "preview-run"))).toBe(true);
    expect(resolveRepositoryFolderPreview(snapshot, mapped, "SHOP", "/F0")).toBeUndefined();
    expect(result.nodes.get(folders[0]!.id)).not.toHaveProperty("selection");
  });

  it("fails closed when a repository path exceeds the depth limit", () => {
    const path = Array.from({ length: REPOSITORY_FOLDER_DEPTH_LIMIT + 1 }, (_, index) => `L${index}`).join("/");
    const snapshot = organization({ repositories: [{
      projectKey: "SHOP",
      tests: [{ key: "SHOP-1", repositoryFolder: { name: "deep", path } }],
      complete: true, truncated: false, errors: [],
    }] });

    const result = projectTraceabilityOrganization(snapshot, mapped);

    expect(result.rows.find((row) => row.label === "SHOP")?.description).toContain("hierarchy truncated");
    expect(result.rows.some((row) => row.actions.some((action) => action.id === "preview-run"))).toBe(false);
  });

  it("hard-caps browser organization rows and renders an omission warning", () => {
    const members = Array.from({ length: ORGANIZATION_ITEM_LIMIT + 100 }, (_, index) => ({ key: `SHOP-${index}` }));
    const result = projectTraceabilityOrganization(organization({ testSetProjects: [{
      projectKey: "SHOP", complete: false, truncated: true, errors: ["bounded"],
      testSets: [{ key: "SHOP-301", issueId: "301", members, remoteMemberCount: members.length, membershipComplete: true, truncated: false, errors: [] }],
    }] }), mapped);

    expect(result.rows.length).toBeLessThanOrEqual(ORGANIZATION_ITEM_LIMIT);
    expect(result.rows.at(-1)?.label).toContain("Test Sets display reached");
  });

  it("renders a Repository warning when repository rows reach the browser limit", () => {
    const tests = Array.from({ length: ORGANIZATION_ITEM_LIMIT }, (_, index) => ({
      key: `SHOP-${index}`, repositoryFolder: { name: "Bulk", path: "/Bulk" },
    }));
    const result = projectTraceabilityOrganization(organization({ repositories: [{
      projectKey: "SHOP", tests, complete: true, truncated: false, errors: [],
    }] }), mapped);

    expect(result.rows.length).toBeLessThanOrEqual(ORGANIZATION_ITEM_LIMIT);
    expect(result.rows.find((row) => row.view === "repository" && row.label.includes("Repository display reached"))).toBeDefined();
  });
});
