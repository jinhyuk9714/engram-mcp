import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getConsolidateIntervalMs,
  registerRecurringJobs
} from "../../lib/http/startup.js";

describe("getConsolidateIntervalMs", () => {
  it("uses the default interval when env is unset", () => {
    assert.equal(getConsolidateIntervalMs({}), 21_600_000);
  });

  it("uses the configured interval when present", () => {
    assert.equal(getConsolidateIntervalMs({ CONSOLIDATE_INTERVAL_MS: "60000" }), 60_000);
  });
});

describe("registerRecurringJobs", () => {
  it("registers the expected recurring tasks and unreferences long-running jobs", async () => {
    const scheduled = [];
    const metricsCalls = [];
    const saveCalls = [];
    const mm = {
      consolidateCalls: 0,
      store: {
        embeddingCalls: 0,
        async generateMissingEmbeddings(batchSize) {
          this.embeddingCalls++;
          assert.equal(batchSize, 20);
          return 0;
        }
      },
      async consolidate() {
        this.consolidateCalls++;
        return {
          expiredDeleted: 1,
          importanceDecay: true,
          duplicatesMerged: 2
        };
      }
    };

    function fakeSetInterval(fn, ms) {
      const handle = {
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
          return this;
        }
      };
      scheduled.push({ fn, ms, handle });
      return handle;
    }

    registerRecurringJobs({
      env: {},
      logDir: "tmp/test-logs",
      setIntervalFn: fakeSetInterval,
      cleanupExpiredSessions: () => {},
      cleanupExpiredOAuthData: () => {},
      getSessionCounts: () => ({ streamable: 2, legacy: 3 }),
      updateSessionCounts: (streamable, legacy) => metricsCalls.push({ streamable, legacy }),
      saveAccessStats: (logDir) => saveCalls.push(logDir),
      memoryManagerFactory: () => mm,
      consoleImpl: { log() {}, error() {} }
    });

    assert.deepEqual(
      scheduled.map((entry) => entry.ms),
      [300_000, 300_000, 60_000, 600_000, 21_600_000, 1_800_000]
    );
    assert.equal(scheduled[4].handle.unrefCalled, true);
    assert.equal(scheduled[5].handle.unrefCalled, true);

    await scheduled[2].fn();
    assert.deepEqual(metricsCalls, [{ streamable: 2, legacy: 3 }]);

    await scheduled[3].fn();
    assert.deepEqual(saveCalls, ["tmp/test-logs"]);

    await scheduled[4].fn();
    await scheduled[5].fn();
    assert.equal(mm.consolidateCalls, 1);
    assert.equal(mm.store.embeddingCalls, 1);
  });
});
