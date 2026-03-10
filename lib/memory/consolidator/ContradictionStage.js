import { queryWithAgentVector } from "../../tools/db.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../gemini.js";
import { detectContradiction as nliDetect, isNLIAvailable } from "../NLIClassifier.js";
import { logDebug, logInfo, logWarn } from "../../logger.js";
import { SCHEMA } from "./constants.js";

async function defaultGetRedisClient() {
  const { redisClient } = await import("../../redis.js");
  return redisClient;
}

export class ContradictionStage {
  constructor({
    store,
    query = queryWithAgentVector,
    geminiJson = geminiCLIJson,
    isGeminiAvailable = isGeminiCLIAvailable,
    detectNli = nliDetect,
    isNliAvailable = isNLIAvailable,
    getRedisClient = defaultGetRedisClient,
    logInfoFn = logInfo,
    logWarnFn = logWarn,
    logDebugFn = logDebug,
    schema = SCHEMA
  } = {}) {
    this.store = store;
    this.query = query;
    this.geminiJson = geminiJson;
    this.isGeminiAvailable = isGeminiAvailable;
    this.detectNli = detectNli;
    this.isNliAvailable = isNliAvailable;
    this.getRedisClient = getRedisClient;
    this.logInfo = logInfoFn;
    this.logWarn = logWarnFn;
    this.logDebug = logDebugFn;
    this.schema = schema;
  }

  async run() {
    const contradictionResult = await this._detectContradictions();

    return {
      contradictionsFound: contradictionResult.found,
      nliResolvedDirectly: contradictionResult.nliResolved,
      nliSkippedAsNonContra: contradictionResult.nliSkipped,
      supersessionsDetected: await this._detectSupersessions(),
      pendingContradictions: await this._processPendingContradictions()
    };
  }

  async _detectContradictions() {
    const redisClient = await this.getRedisClient();
    const LAST_CHECK_KEY = "frag:contradiction_check_at";
    const PENDING_KEY = "frag:pending_contradictions";

    let lastCheckAt = null;
    try {
      if (redisClient && redisClient.status === "ready") {
        const value = await redisClient.get(LAST_CHECK_KEY);
        lastCheckAt = value || null;
      }
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Redis lastCheckAt read failed: ${err.message}`);
    }

    let newFragmentsQuery = `
      SELECT id, content, topic, type, importance, embedding, created_at
      FROM ${this.schema}.fragments
      WHERE embedding IS NOT NULL`;

    const params = [];
    if (lastCheckAt) {
      params.push(lastCheckAt);
      newFragmentsQuery += " AND created_at > $1";
    }
    newFragmentsQuery += " ORDER BY created_at DESC LIMIT 20";

    const newFragments = await this.query("system", newFragmentsQuery, params);
    if (!newFragments.rows || newFragments.rows.length === 0) {
      return { found: 0, nliResolved: 0, nliSkipped: 0 };
    }

    const nliAvailable = this.isNliAvailable();
    const geminiAvailable = await this.isGeminiAvailable();
    let found = 0;
    let nliResolved = 0;
    let nliSkipped = 0;
    let latestProcessed = null;

    for (const newFragment of newFragments.rows) {
      const candidates = await this.query(
        "system",
        `SELECT c.id, c.content, c.topic, c.type, c.importance,
                c.created_at, c.is_anchor,
                1 - (c.embedding <=> (SELECT embedding FROM ${this.schema}.fragments WHERE id = $1)) AS similarity
         FROM ${this.schema}.fragments c
         WHERE c.id != $1
           AND c.topic = $2
           AND c.embedding IS NOT NULL
           AND 1 - (c.embedding <=> (SELECT embedding FROM ${this.schema}.fragments WHERE id = $1)) > 0.85
           AND NOT EXISTS (
             SELECT 1 FROM ${this.schema}.fragment_links fl
             WHERE ((fl.from_id = $1 AND fl.to_id = c.id)
                 OR (fl.from_id = c.id AND fl.to_id = $1))
               AND fl.relation_type = 'contradicts'
           )
         ORDER BY similarity DESC
         LIMIT 3`,
        [newFragment.id, newFragment.topic]
      );

      if (!candidates.rows || candidates.rows.length === 0) continue;

      for (const candidate of candidates.rows) {
        if (nliAvailable) {
          const nliResult = await this.detectNli(newFragment.content, candidate.content);

          if (nliResult) {
            if (nliResult.contradicts && !nliResult.needsEscalation) {
              await this._resolveContradiction(
                newFragment,
                candidate,
                `NLI contradiction (conf=${nliResult.confidence.toFixed(3)})`
              );
              found++;
              nliResolved++;
              if (!latestProcessed || newFragment.created_at > latestProcessed) {
                latestProcessed = newFragment.created_at;
              }
              continue;
            }

            if (!nliResult.contradicts && !nliResult.needsEscalation) {
              nliSkipped++;
              if (!latestProcessed || newFragment.created_at > latestProcessed) {
                latestProcessed = newFragment.created_at;
              }
              continue;
            }
          }
        }

        if (!geminiAvailable) {
          if (parseFloat(candidate.similarity) > 0.92) {
            await this._flagPotentialContradiction(redisClient, PENDING_KEY, newFragment, candidate);
          }
          continue;
        }

        try {
          const verdict = await this._askGeminiContradiction(newFragment.content, candidate.content);
          if (verdict.contradicts) {
            await this._resolveContradiction(newFragment, candidate, verdict.reasoning);
            found++;
          }
          if (!latestProcessed || newFragment.created_at > latestProcessed) {
            latestProcessed = newFragment.created_at;
          }
        } catch (err) {
          this.logWarn(`[MemoryConsolidator] Gemini contradiction check failed: ${err.message}`);
        }
      }
    }

    if (latestProcessed) {
      await this._updateContradictionTimestamp(redisClient, LAST_CHECK_KEY, latestProcessed);
    }

    if (nliResolved > 0 || nliSkipped > 0) {
      this.logInfo(`[MemoryConsolidator] NLI stats: ${nliResolved} resolved, ${nliSkipped} skipped (saved ${nliResolved + nliSkipped} Gemini calls)`);
    }

    return { found, nliResolved, nliSkipped };
  }

  async _resolveContradiction(newFragment, candidate, reasoning) {
    await this.store.createLink(newFragment.id, candidate.id, "contradicts", "system");

    const newDate = new Date(newFragment.created_at);
    const oldDate = new Date(candidate.created_at);

    if (newDate > oldDate) {
      if (!candidate.is_anchor) {
        await this.query(
          "system",
          `UPDATE ${this.schema}.fragments SET importance = importance * 0.5 WHERE id = $1`,
          [candidate.id],
          "write"
        );
      }
      await this.store.createLink(candidate.id, newFragment.id, "superseded_by", "system");
      await this.query(
        "system",
        `UPDATE ${this.schema}.fragments SET valid_to = NOW()
         WHERE id = $1 AND valid_to IS NULL`,
        [candidate.id],
        "write"
      );
    } else {
      await this.query(
        "system",
        `UPDATE ${this.schema}.fragments SET importance = importance * 0.5 WHERE id = $1`,
        [newFragment.id],
        "write"
      );
      await this.store.createLink(newFragment.id, candidate.id, "superseded_by", "system");
      await this.query(
        "system",
        `UPDATE ${this.schema}.fragments SET valid_to = NOW()
         WHERE id = $1 AND valid_to IS NULL`,
        [newFragment.id],
        "write"
      );
    }

    this.logInfo(`[MemoryConsolidator] Contradiction resolved: ${newFragment.id} <-> ${candidate.id}: ${reasoning}`);
  }

  async _detectSupersessions() {
    const geminiAvailable = await this.isGeminiAvailable();
    if (!geminiAvailable) return 0;

    const candidates = await this.query(
      "system",
      `SELECT a.id AS id_a, a.content AS content_a, a.created_at AS created_a,
              b.id AS id_b, b.content AS content_b, b.created_at AS created_b,
              1 - (a.embedding <=> b.embedding) AS similarity
       FROM ${this.schema}.fragments a
       JOIN ${this.schema}.fragments b ON a.topic = b.topic
                                      AND a.type = b.type
                                      AND a.id < b.id
       WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
         AND a.valid_to IS NULL AND b.valid_to IS NULL
         AND 1 - (a.embedding <=> b.embedding) BETWEEN 0.7 AND 0.85
         AND NOT EXISTS (
           SELECT 1 FROM ${this.schema}.fragment_links fl
           WHERE (fl.from_id = a.id AND fl.to_id = b.id)
              OR (fl.from_id = b.id AND fl.to_id = a.id)
         )
       ORDER BY similarity DESC
       LIMIT 10`,
      []
    );

    if (!candidates.rows || candidates.rows.length === 0) return 0;

    let detected = 0;

    for (const pair of candidates.rows) {
      try {
        const verdict = await this._askGeminiSupersession(pair.content_a, pair.content_b);

        if (verdict.supersedes) {
          const older = new Date(pair.created_a) < new Date(pair.created_b)
            ? { id: pair.id_a, content: pair.content_a, created_at: pair.created_a }
            : { id: pair.id_b, content: pair.content_b, created_at: pair.created_b };
          const newer = older.id === pair.id_a
            ? { id: pair.id_b, content: pair.content_b, created_at: pair.created_b }
            : { id: pair.id_a, content: pair.content_a, created_at: pair.created_a };

          await this.store.createLink(older.id, newer.id, "superseded_by", "system");
          await this.query(
            "system",
            `UPDATE ${this.schema}.fragments
             SET valid_to = NOW(), importance = GREATEST(0.05, importance * 0.5)
             WHERE id = $1 AND valid_to IS NULL`,
            [older.id],
            "write"
          );

          this.logInfo(`[MemoryConsolidator] Supersession: ${older.id} -> ${newer.id}: ${verdict.reasoning}`);
          detected++;
        }
      } catch (err) {
        this.logWarn(`[MemoryConsolidator] Supersession check failed: ${err.message}`);
      }
    }

    return detected;
  }

  async _askGeminiSupersession(contentA, contentB) {
    const prompt = `두 개의 지식 파편이 "대체 관계"인지 판단하라.

파편 A: "${contentA}"
파편 B: "${contentB}"

대체 관계란: 동일 주제에 대해 한쪽이 다른 쪽의 정보를 갱신·교체·전환한 경우.
예: "cron으로 스케줄링" -> "Airflow로 전환" = 대체 관계
예: "Redis 캐시 사용" + "Redis 포트 6379" = 보완 관계 (대체 아님)

반드시 다음 JSON 형식으로만 응답하라:
{"supersedes": true 또는 false, "reasoning": "판단 근거 1문장"}`;

    try {
      return await this.geminiJson(prompt, { timeoutMs: 30_000 });
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Gemini supersession parse failed: ${err.message}`);
      return { supersedes: false, reasoning: "Gemini CLI 응답 파싱 실패" };
    }
  }

  async _askGeminiContradiction(contentA, contentB) {
    const prompt = `두 개의 지식 파편이 서로 모순되는지 판단하라.

파편 A: "${contentA}"
파편 B: "${contentB}"

모순이란: 동일 주제에 대해 서로 양립 불가능한 주장을 하는 경우.
유사하지만 보완적인 정보는 모순이 아니다.
시간 경과에 의한 정보 갱신도 모순으로 판단한다 (구 정보 vs 신 정보).

반드시 다음 JSON 형식으로만 응답하라:
{"contradicts": true 또는 false, "reasoning": "판단 근거 1문장"}`;

    try {
      return await this.geminiJson(prompt, { timeoutMs: 30_000 });
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Gemini CLI parse failed: ${err.message}`);
      return { contradicts: false, reasoning: "Gemini CLI 응답 파싱 실패" };
    }
  }

  async _flagPotentialContradiction(redisClient, key, fragmentA, fragmentB) {
    try {
      if (redisClient && redisClient.status === "ready") {
        const entry = JSON.stringify({
          idA: fragmentA.id,
          idB: fragmentB.id,
          contentA: fragmentA.content,
          contentB: fragmentB.content,
          flaggedAt: new Date().toISOString()
        });
        await redisClient.rpush(key, entry);
        this.logDebug(`[MemoryConsolidator] Flagged potential contradiction: ${fragmentA.id} <-> ${fragmentB.id}`);
      }
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Failed to flag contradiction: ${err.message}`);
    }
  }

  async _processPendingContradictions() {
    if (!(await this.isGeminiAvailable())) return 0;

    const redisClient = await this.getRedisClient();
    const PENDING_KEY = "frag:pending_contradictions";

    if (!redisClient || redisClient.status !== "ready") return 0;

    let processed = 0;
    const batchSize = 10;

    for (let index = 0; index < batchSize; index++) {
      const raw = await redisClient.lpop(PENDING_KEY);
      if (!raw) break;

      try {
        const entry = JSON.parse(raw);
        const verdict = await this._askGeminiContradiction(entry.contentA, entry.contentB);

        if (verdict.contradicts) {
          const fragmentAResult = await this.query(
            "system",
            `SELECT id, content, created_at, is_anchor FROM ${this.schema}.fragments WHERE id = $1`,
            [entry.idA]
          );
          const fragmentBResult = await this.query(
            "system",
            `SELECT id, content, created_at, is_anchor FROM ${this.schema}.fragments WHERE id = $1`,
            [entry.idB]
          );

          if (fragmentAResult.rows.length && fragmentBResult.rows.length) {
            await this._resolveContradiction(
              fragmentAResult.rows[0],
              fragmentBResult.rows[0],
              verdict.reasoning
            );
            processed++;
          }
        }
      } catch (err) {
        this.logWarn(`[MemoryConsolidator] Pending contradiction processing failed: ${err.message}`);
        try {
          await redisClient.rpush(PENDING_KEY, raw);
        } catch {
          // ignore
        }
        break;
      }
    }

    if (processed > 0) {
      this.logInfo(`[MemoryConsolidator] Processed ${processed} pending contradictions`);
    }

    return processed;
  }

  async _updateContradictionTimestamp(redisClient, key, timestamp) {
    try {
      if (redisClient && redisClient.status === "ready") {
        const normalizedTimestamp = timestamp instanceof Date
          ? timestamp.toISOString()
          : (typeof timestamp === "string" ? timestamp : new Date().toISOString());
        await redisClient.set(key, normalizedTimestamp);
      }
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Contradiction timestamp update failed: ${err.message}`);
    }
  }
}
