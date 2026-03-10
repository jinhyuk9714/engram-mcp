import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ContradictionStage } from "../../lib/memory/consolidator/ContradictionStage.js";
import { ReportingStage } from "../../lib/memory/consolidator/ReportingStage.js";

describe("ContradictionStage", () => {
  test("aggregates contradiction, supersession, and pending-queue results into the existing flat shape", async () => {
    const stage = new ContradictionStage();
    stage._detectContradictions = async () => ({
      found: 4,
      nliResolved: 2,
      nliSkipped: 1
    });
    stage._detectSupersessions = async () => 3;
    stage._processPendingContradictions = async () => 5;

    const result = await stage.run();

    assert.deepStrictEqual(result, {
      contradictionsFound: 4,
      nliResolvedDirectly: 2,
      nliSkippedAsNonContra: 1,
      supersessionsDetected: 3,
      pendingContradictions: 5
    });
  });
});

describe("ReportingStage", () => {
  test("returns the existing reporting/result fields while delegating side effects to injected dependencies", async () => {
    const calls = [];
    const stage = new ReportingStage({
      index: {
        async pruneKeywordIndexes() {
          calls.push("prune");
        }
      }
    });

    stage._generateFeedbackReport = async () => {
      calls.push("report");
      return true;
    };
    stage._collectStaleFragments = async () => {
      calls.push("stale");
      return [{ id: "stale-1" }];
    };
    stage._purgeStaleReflections = async () => {
      calls.push("purge");
      return 6;
    };

    const result = await stage.run();

    assert.deepStrictEqual(calls, ["report", "prune", "stale", "purge"]);
    assert.deepStrictEqual(result, {
      feedbackReportGenerated: true,
      indexesPruned: true,
      stale_fragments: [{ id: "stale-1" }],
      reflectionsPurged: 6
    });
  });
});
