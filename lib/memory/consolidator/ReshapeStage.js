import { randomUUID } from "crypto";

import { getPrimaryPool, queryWithAgentVector } from "../../tools/db.js";
import { MEMORY_CONFIG } from "../../../config/memory.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../gemini.js";
import { logInfo, logWarn } from "../../logger.js";
import { SCHEMA } from "./constants.js";

export class ReshapeStage {
  constructor({
    store,
    getPrimaryPoolFn = getPrimaryPool,
    query = queryWithAgentVector,
    memoryConfig = MEMORY_CONFIG,
    geminiJson = geminiCLIJson,
    isGeminiAvailable = isGeminiCLIAvailable,
    logInfoFn = logInfo,
    logWarnFn = logWarn,
    schema = SCHEMA
  } = {}) {
    this.store = store;
    this.getPrimaryPool = getPrimaryPoolFn;
    this.query = query;
    this.memoryConfig = memoryConfig;
    this.geminiJson = geminiJson;
    this.isGeminiAvailable = isGeminiAvailable;
    this.logInfo = logInfoFn;
    this.logWarn = logWarnFn;
    this.schema = schema;
  }

  async run() {
    return {
      fragmentsSplit: await this._splitLongFragments(),
      duplicatesMerged: await this._mergeDuplicates()
    };
  }

  async _mergeDuplicates() {
    const result = await this.query(
      "system",
      `WITH dups AS (
         SELECT content_hash,
                array_agg(id ORDER BY importance DESC, created_at ASC) AS ids,
                count(*) AS cnt
         FROM ${this.schema}.fragments
         GROUP BY content_hash
         HAVING count(*) > 1
       )
       SELECT * FROM dups LIMIT 50`
    );

    let merged = 0;

    for (const duplicate of result.rows) {
      const keepId = duplicate.ids[0];
      const removeIds = duplicate.ids.slice(1);

      for (const removeId of removeIds) {
        await this.query(
          "system",
          `UPDATE ${this.schema}.fragments
           SET linked_to = array_append(
             CASE WHEN NOT ($1 = ANY(linked_to)) THEN linked_to ELSE linked_to END, $1
           )
           WHERE id = ANY($2) AND NOT ($1 = ANY(linked_to))
           RETURNING id`,
          [keepId, [removeId]],
          "write"
        );

        await this.query(
          "system",
          `UPDATE ${this.schema}.fragments
           SET linked_to = array_replace(linked_to, $1, $2)
           WHERE $1 = ANY(linked_to)`,
          [removeId, keepId],
          "write"
        );

        await this.store.delete(removeId, "system");
        merged++;
      }
    }

    return merged;
  }

  async _splitLongFragments() {
    if (!await this.isGeminiAvailable()) return 0;

    const pool = this.getPrimaryPool();
    if (!pool) return 0;

    const cfg = this.memoryConfig.fragmentSplit || {};
    const threshold = cfg.lengthThreshold ?? 300;
    const batchSize = cfg.batchSize ?? 10;
    const minItems = cfg.minItems ?? 2;
    const maxItems = cfg.maxItems ?? 8;
    const timeoutMs = cfg.timeoutMs ?? 30_000;

    const candidates = await pool.query(
      `SELECT id, content, topic, type, importance, agent_id, key_id
       FROM ${this.schema}.fragments
       WHERE length(content) > $1
         AND valid_to IS NULL
         AND is_anchor = FALSE
       ORDER BY length(content) DESC
       LIMIT $2`,
      [threshold, batchSize]
    );

    if (candidates.rows.length === 0) return 0;

    let splitCount = 0;

    for (const fragment of candidates.rows) {
      try {
        const prompt =
          `다음 텍스트를 의미 단위로 쪼개어 각각 1~2문장의 원자적 사실로 분리하라.\n\n` +
          `텍스트:\n${fragment.content}\n\n` +
          `규칙:\n` +
          `- 항목 1개 = 독립적으로 이해 가능한 단일 사실.\n` +
          `- 1~2문장을 넘지 않는다.\n` +
          `- 원문 정보를 손실 없이 유지한다.\n` +
          `- ${minItems}~${maxItems}개 항목으로 분리한다.\n\n` +
          `JSON 배열만 출력하라 (설명 없이):\n["항목1", "항목2", ...]`;

        const items = await this.geminiJson(prompt, { timeoutMs });
        if (!Array.isArray(items) || items.length < minItems) continue;

        const agentId = fragment.agent_id || "default";
        const keyId = fragment.key_id ?? null;
        const newIds = [];

        for (const item of items.slice(0, maxItems)) {
          const text = typeof item === "string" ? item.trim() : String(item).trim();
          if (!text) continue;

          const newId = randomUUID();
          const inserted = await this.store.insert({
            id: newId,
            content: text,
            topic: fragment.topic,
            type: fragment.type,
            importance: fragment.importance,
            keywords: [],
            source: `split:${fragment.id}`,
            linked_to: [],
            ttl_tier: "warm",
            is_anchor: false,
            agent_id: agentId,
            key_id: keyId
          });

          if (inserted) newIds.push(inserted);
        }

        if (newIds.length < minItems) continue;

        for (let index = 1; index < newIds.length; index++) {
          await this.store.createLink(newIds[index - 1], newIds[index], "related", agentId).catch(() => {});
        }

        for (const childId of newIds) {
          await this.store.createLink(childId, fragment.id, "part_of", agentId).catch(() => {});
        }

        await pool.query(
          `UPDATE ${this.schema}.fragments
           SET valid_to = NOW(),
               importance = GREATEST(0.05, importance * 0.3)
           WHERE id = $1`,
          [fragment.id]
        );

        splitCount++;
        this.logInfo(`[MemoryConsolidator] Split fragment ${fragment.id} -> ${newIds.length} atomic fragments`);
      } catch (err) {
        this.logWarn(`[MemoryConsolidator] _splitLongFragments failed for ${fragment.id}: ${err.message}`);
      }
    }

    return splitCount;
  }
}
