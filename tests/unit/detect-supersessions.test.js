import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("_detectSupersessions", () => {
  test("ContradictionStage에 _detectSupersessions 메서드가 존재한다", async () => {
    const { ContradictionStage } = await import("../../lib/memory/consolidator/ContradictionStage.js");
    const stage = new ContradictionStage();
    assert.strictEqual(typeof stage._detectSupersessions, "function");
  });

  test("ContradictionStage에 _askGeminiSupersession 메서드가 존재한다", async () => {
    const { ContradictionStage } = await import("../../lib/memory/consolidator/ContradictionStage.js");
    const stage = new ContradictionStage();
    assert.strictEqual(typeof stage._askGeminiSupersession, "function");
  });
});
