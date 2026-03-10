import { MEMORY_CONFIG } from "../../../config/memory.js";
import { queryWithAgentVector } from "../../tools/db.js";
import { logWarn } from "../../logger.js";
import { SCHEMA } from "./constants.js";

export class LifecycleStage {
  constructor({
    store,
    query = queryWithAgentVector,
    memoryConfig = MEMORY_CONFIG,
    logWarnFn = logWarn,
    schema = SCHEMA
  } = {}) {
    this.store = store;
    this.query = query;
    this.memoryConfig = memoryConfig;
    this.logWarn = logWarnFn;
    this.schema = schema;
  }

  async run() {
    const ttlTransitions = await this._transitionWithCount();
    await this.store.decayImportance();
    const expiredDeleted = await this.store.deleteExpired();
    const gcCandidatesByType = await this._previewGcCandidates();

    return {
      ttlTransitions,
      importanceDecay: true,
      expiredDeleted,
      gcCandidatesByType
    };
  }

  async _transitionWithCount() {
    const before = await this.query(
      "system",
      `SELECT ttl_tier, count(*)::int AS cnt
       FROM ${this.schema}.fragments GROUP BY ttl_tier`
    );
    const beforeMap = new Map(before.rows.map(row => [row.ttl_tier, row.cnt]));

    await this.store.transitionTTL();

    const after = await this.query(
      "system",
      `SELECT ttl_tier, count(*)::int AS cnt
       FROM ${this.schema}.fragments GROUP BY ttl_tier`
    );

    let transitions = 0;
    for (const row of after.rows) {
      const previous = beforeMap.get(row.ttl_tier) || 0;
      transitions += Math.abs(row.cnt - previous);
    }

    return Math.floor(transitions / 2);
  }

  async _previewGcCandidates() {
    try {
      const gcPreview = await this.query(
        "system",
        `SELECT type, COUNT(*) as cnt FROM ${this.schema}.fragments
         WHERE utility_score < ${this.memoryConfig.gc?.utilityThreshold || 0.15}
           AND ttl_tier NOT IN ('permanent') AND is_anchor = FALSE
         GROUP BY type`,
        []
      );

      return Object.fromEntries(gcPreview.rows.map(row => [row.type, parseInt(row.cnt, 10)]));
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] GC preview query failed: ${err.message}`);
      return {};
    }
  }
}
