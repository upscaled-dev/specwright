import type { AuthoredTest, NewTestSpec } from "./contracts";
import { errMsg } from "../utils/text";
import { createAndTagTest } from "./link-scenario";
import type { ScenarioRef } from "./scenario-ref";
import type { TagWrite } from "./tag-edit";

// One selected scenario to author a test from: the ref the tag write lands on, and the verbatim source
// slice the create posts. The slice is read by the caller before the loop starts, so no document read
// ever sits between a create and its tag write.
export interface BulkCreateScenario {
  readonly ref: ScenarioRef;
  readonly gherkin: string;
}

export interface BulkCreateDeps {
  // Is the scenario still exactly where the batch wrote it down? Checked immediately before its create,
  // because lines move: this batch's own inserts shift them, and so does any edit from outside.
  locationHolds(scenario: BulkCreateScenario): Promise<boolean>;
  createTest(spec: NewTestSpec, signal?: AbortSignal): Promise<AuthoredTest>;
  // The truthful tag write (tag-edit's spine): "rejected" means the edit never reached disk, so the
  // summary can never claim a tag that isn't in the file.
  insertTag(scenario: BulkCreateScenario, key: string): Promise<TagWrite<"inserted">>;
  merge(key: string): void;
  // Called before each item, so the progress UI can name the scenario about to be created.
  report(scenario: BulkCreateScenario, index: number): void;
}

export interface BulkCreateResult {
  readonly created: ReadonlyArray<{ scenario: BulkCreateScenario; key: string }>;
  readonly failed: ReadonlyArray<{ scenario: BulkCreateScenario; reason: string }>;
}

const FILE_CHANGED = "the feature file changed during the batch";

/**
 * Create one remote test per selected scenario, tagging each scenario as its test lands. The loop is
 * SEQUENTIAL by design: every create and its tag write settle before the next item starts, so an abort
 * stops between items and never mid-write, and whatever already happened is still reported.
 *
 * A scenario whose location no longer holds is failed WITHOUT a remote call: the batch wrote those
 * locations down before the confirm, and tagging a line that now belongs to another scenario would
 * corrupt the file. Both dishonest outcomes after a create count as failures with the created key
 * named, because the remote test exists while nothing local points at it: a create that answers no
 * readable key (nothing to tag with) and a refused tag write. The refused write still merges the key,
 * like the single create flow does, so the link picker can attach it without a full sync.
 */
export async function runBulkCreate(
  scenarios: readonly BulkCreateScenario[],
  project: string,
  deps: BulkCreateDeps,
  signal: AbortSignal
): Promise<BulkCreateResult> {
  const created: Array<{ scenario: BulkCreateScenario; key: string }> = [];
  const failed: Array<{ scenario: BulkCreateScenario; reason: string }> = [];
  for (const [index, scenario] of scenarios.entries()) {
    if (signal.aborted) {
      break;
    }
    let write: TagWrite<"inserted"> | undefined;
    try {
      deps.report(scenario, index);
      if (!(await deps.locationHolds(scenario))) {
        failed.push({ scenario, reason: FILE_CHANGED });
        continue;
      }
      const test = await createAndTagTest(
        { project, summary: scenario.ref.name, gherkin: scenario.gherkin },
        {
          createTest: (input, abort) => deps.createTest(input, abort),
          insertTag: async (key) => {
            write = await deps.insertTag(scenario, key);
          },
          merge: deps.merge,
        },
        signal
      );
      if (test.key === undefined) {
        const idNote = test.issueId !== undefined ? ` (issue id ${test.issueId})` : "";
        failed.push({ scenario, reason: `the test was created${idNote} but its key could not be read back, so no tag was inserted` });
      } else if (write === "rejected") {
        failed.push({ scenario, reason: `${test.key} was created, but the feature file edit was not applied` });
      } else {
        created.push({ scenario, key: test.key });
      }
    } catch (error) {
      failed.push({ scenario, reason: errMsg(error) });
    }
  }
  return { created, failed };
}
