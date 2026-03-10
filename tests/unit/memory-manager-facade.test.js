import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MemoryManager } from "../../lib/memory/MemoryManager.js";

function createFacade() {
  const manager = new MemoryManager();

  manager.store   = null;
  manager.index   = null;
  manager.search  = null;
  manager.factory = null;

  manager.writeService = {
    async remember(params) { return { delegatedTo: "write.remember", params }; },
    async amend(params) { return { delegatedTo: "write.amend", params }; },
    async forget(params) { return { delegatedTo: "write.forget", params }; },
    async link(params) { return { delegatedTo: "write.link", params }; },
    async deleteByAgent(agentId) { return { delegatedTo: "write.deleteByAgent", agentId }; }
  };

  manager.queryService = {
    async recall(params) { return { delegatedTo: "query.recall", params }; },
    async context(params) { return { delegatedTo: "query.context", params }; },
    async fragmentHistory(params) { return { delegatedTo: "query.fragmentHistory", params }; },
    async graphExplore(params) { return { delegatedTo: "query.graphExplore", params }; }
  };

  manager.sessionService = {
    async reflect(params) { return { delegatedTo: "session.reflect", params }; }
  };

  manager.consolidator = {
    async consolidate() { return { delegatedTo: "consolidator.consolidate" }; },
    async getStats() { return { delegatedTo: "consolidator.stats" }; }
  };

  return manager;
}

describe("MemoryManager facade delegation", () => {
  test("write methods delegate to writeService", async () => {
    const manager = createFacade();

    await assert.doesNotReject(async () => {
      assert.deepStrictEqual(
        await manager.remember({ content: "hello", topic: "test", type: "fact" }),
        { delegatedTo: "write.remember", params: { content: "hello", topic: "test", type: "fact" } }
      );
      assert.deepStrictEqual(
        await manager.amend({ id: "frag-1" }),
        { delegatedTo: "write.amend", params: { id: "frag-1" } }
      );
      assert.deepStrictEqual(
        await manager.forget({ id: "frag-2" }),
        { delegatedTo: "write.forget", params: { id: "frag-2" } }
      );
      assert.deepStrictEqual(
        await manager.link({ fromId: "a", toId: "b" }),
        { delegatedTo: "write.link", params: { fromId: "a", toId: "b" } }
      );
      assert.deepStrictEqual(
        await manager.deleteByAgent("agent-x"),
        { delegatedTo: "write.deleteByAgent", agentId: "agent-x" }
      );
    });
  });

  test("query methods delegate to queryService", async () => {
    const manager = createFacade();

    await assert.doesNotReject(async () => {
      assert.deepStrictEqual(
        await manager.recall({ topic: "test" }),
        { delegatedTo: "query.recall", params: { topic: "test" } }
      );
      assert.deepStrictEqual(
        await manager.context({ sessionId: "session-1" }),
        { delegatedTo: "query.context", params: { sessionId: "session-1" } }
      );
      assert.deepStrictEqual(
        await manager.fragmentHistory({ id: "frag-1" }),
        { delegatedTo: "query.fragmentHistory", params: { id: "frag-1" } }
      );
      assert.deepStrictEqual(
        await manager.graphExplore({ startId: "frag-2" }),
        { delegatedTo: "query.graphExplore", params: { startId: "frag-2" } }
      );
    });
  });

  test("session and consolidator methods keep their existing surface", async () => {
    const manager = createFacade();

    assert.deepStrictEqual(
      await manager.reflect({ sessionId: "session-2" }),
      { delegatedTo: "session.reflect", params: { sessionId: "session-2" } }
    );
    assert.deepStrictEqual(
      await manager.consolidate(),
      { delegatedTo: "consolidator.consolidate" }
    );
    assert.deepStrictEqual(
      await manager.stats(),
      { delegatedTo: "consolidator.stats" }
    );
  });
});
