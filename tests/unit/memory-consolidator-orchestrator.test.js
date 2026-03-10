import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { MemoryConsolidator } from "../../lib/memory/MemoryConsolidator.js";

describe("MemoryConsolidator orchestrator", () => {
  test("builds default stages in the existing pipeline order", () => {
    const consolidator = new MemoryConsolidator();
    assert.deepStrictEqual(
      consolidator.stages.map(stage => stage.constructor.name),
      [
        "LifecycleStage",
        "ReshapeStage",
        "LinkingStage",
        "ScoringStage",
        "ContradictionStage",
        "ReportingStage"
      ]
    );
  });

  test("runs injected stages in order and merges flat result patches", async () => {
    const order = [];
    const consolidator = new MemoryConsolidator({
      stages: [
        {
          async run() {
            order.push("lifecycle");
            return { ttlTransitions: 3, importanceDecay: true };
          }
        },
        {
          async run() {
            order.push("reshape");
            return { duplicatesMerged: 2, fragmentsSplit: 1 };
          }
        },
        {
          async run() {
            order.push("reporting");
            return { feedbackReportGenerated: true, stale_fragments: [{ id: "frag-1" }] };
          }
        }
      ]
    });

    const result = await consolidator.consolidate();

    assert.deepStrictEqual(order, ["lifecycle", "reshape", "reporting"]);
    assert.equal(result.ttlTransitions, 3);
    assert.equal(result.importanceDecay, true);
    assert.equal(result.duplicatesMerged, 2);
    assert.equal(result.fragmentsSplit, 1);
    assert.equal(result.feedbackReportGenerated, true);
    assert.deepStrictEqual(result.stale_fragments, [{ id: "frag-1" }]);
    assert.equal(result.expiredDeleted, 0);
    assert.equal(result.indexesPruned, false);
  });
});
