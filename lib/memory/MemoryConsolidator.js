/**
 * MemoryConsolidator - maintenance pipeline orchestrator
 *
 * Public surface stays the same while stage implementations live in
 * lib/memory/consolidator/ for easier testing and targeted changes.
 */

import { FragmentStore } from "./FragmentStore.js";
import { FragmentIndex } from "./FragmentIndex.js";
import { getPrimaryPool } from "../tools/db.js";
import { logError, logInfo } from "../logger.js";
import { ContradictionStage } from "./consolidator/ContradictionStage.js";
import { LifecycleStage } from "./consolidator/LifecycleStage.js";
import { LinkingStage } from "./consolidator/LinkingStage.js";
import { ReportingStage } from "./consolidator/ReportingStage.js";
import { ReshapeStage } from "./consolidator/ReshapeStage.js";
import { ScoringStage } from "./consolidator/ScoringStage.js";
import { createConsolidationResults, SCHEMA } from "./consolidator/constants.js";

export class MemoryConsolidator {
  constructor(overrides = {}) {
    this.store = overrides.store ?? new FragmentStore();
    this.index = overrides.index ?? new FragmentIndex();
    this.schema = overrides.schema ?? SCHEMA;
    this.stages = overrides.stages ?? this._buildDefaultStages(overrides);
  }

  _buildDefaultStages(overrides) {
    const sharedDeps = {
      store: this.store,
      index: this.index,
      schema: this.schema,
      ...overrides.stageDeps
    };

    return [
      new LifecycleStage(sharedDeps),
      new ReshapeStage(sharedDeps),
      new LinkingStage(sharedDeps),
      new ScoringStage(sharedDeps),
      new ContradictionStage(sharedDeps),
      new ReportingStage(sharedDeps)
    ];
  }

  async consolidate() {
    const results = createConsolidationResults();

    try {
      for (const stage of this.stages) {
        const patch = await stage.run();
        if (patch && typeof patch === "object") {
          Object.assign(results, patch);
        }
      }
    } catch (err) {
      logError(`[MemoryConsolidator] consolidation error: ${err.message}`, err);
      results.error = err.message;
    }

    logInfo("[MemoryConsolidator] Result:", { results });
    return results;
  }

  async getStats() {
    const pool = getPrimaryPool();
    if (!pool) return {};

    const result = await pool.query(
      `SELECT
         count(*)                                                     AS total,
         count(*) FILTER (WHERE ttl_tier = 'permanent')               AS permanent,
         count(*) FILTER (WHERE ttl_tier = 'hot')                     AS hot,
         count(*) FILTER (WHERE ttl_tier = 'warm')                    AS warm,
         count(*) FILTER (WHERE ttl_tier = 'cold')                    AS cold,
         count(*) FILTER (WHERE embedding IS NOT NULL)                AS embedded,
         avg(importance)                                              AS avg_importance,
         count(DISTINCT topic)                                        AS topic_count,
         count(*) FILTER (WHERE type = 'error')                       AS error_count,
         count(*) FILTER (WHERE type = 'preference')                  AS preference_count,
         count(*) FILTER (WHERE type = 'decision')                    AS decision_count,
         count(*) FILTER (WHERE type = 'procedure')                   AS procedure_count,
         count(*) FILTER (WHERE type = 'fact')                        AS fact_count,
         count(*) FILTER (WHERE type = 'relation')                    AS relation_count,
         sum(access_count)                                            AS total_accesses,
         avg(utility_score)                                           AS avg_utility,
         sum(estimated_tokens)                                        AS total_tokens
       FROM ${this.schema}.fragments`
    );

    const stats = result.rows[0];
    stats.avg_importance = parseFloat(stats.avg_importance || 0).toFixed(3);
    stats.avg_utility = parseFloat(stats.avg_utility || 0).toFixed(3);
    stats.total_tokens = parseInt(stats.total_tokens || 0, 10);

    return stats;
  }
}
