import { getPrimaryPool, queryWithAgentVector } from "../../tools/db.js";
import { MEMORY_CONFIG } from "../../../config/memory.js";
import { logInfo, logWarn } from "../../logger.js";
import { SCHEMA } from "./constants.js";

async function defaultGetRedisClient() {
  const { redisClient } = await import("../../redis.js");
  return redisClient;
}

export class ReportingStage {
  constructor({
    index,
    getPrimaryPoolFn = getPrimaryPool,
    query = queryWithAgentVector,
    getRedisClient = defaultGetRedisClient,
    memoryConfig = MEMORY_CONFIG,
    logInfoFn = logInfo,
    logWarnFn = logWarn,
    schema = SCHEMA
  } = {}) {
    this.index = index;
    this.getPrimaryPool = getPrimaryPoolFn;
    this.query = query;
    this.getRedisClient = getRedisClient;
    this.memoryConfig = memoryConfig;
    this.logInfo = logInfoFn;
    this.logWarn = logWarnFn;
    this.schema = schema;
  }

  async run() {
    const feedbackReportGenerated = await this._generateFeedbackReport();
    await this.index.pruneKeywordIndexes();

    return {
      feedbackReportGenerated,
      indexesPruned: true,
      stale_fragments: await this._collectStaleFragments(),
      reflectionsPurged: await this._purgeStaleReflections()
    };
  }

  async _generateFeedbackReport() {
    const pool = this.getPrimaryPool();
    if (!pool) return false;

    try {
      const redisClient = await this.getRedisClient();
      const LAST_REPORT_KEY = "frag:feedback_report_at";

      let lastReportAt = null;
      try {
        if (redisClient && redisClient.status === "ready") {
          lastReportAt = await redisClient.get(LAST_REPORT_KEY);
        }
      } catch (err) {
        this.logWarn(`[MemoryConsolidator] Redis lastReportAt read failed: ${err.message}`);
      }

      const params = [];
      let dateFilter = "";
      if (lastReportAt) {
        params.push(lastReportAt);
        dateFilter = "AND created_at > $1";
      }

      const toolStats = await pool.query(
        `SELECT
           tool_name,
           count(*)::int AS total,
           count(*) FILTER (WHERE relevant = true)::int AS relevant_count,
           count(*) FILTER (WHERE sufficient = true)::int AS sufficient_count,
           count(*) FILTER (WHERE trigger_type = 'sampled')::int AS sampled_count,
           count(*) FILTER (WHERE trigger_type = 'voluntary')::int AS voluntary_count
         FROM agent_memory.tool_feedback
         WHERE 1=1 ${dateFilter}
         GROUP BY tool_name
         ORDER BY total DESC`,
        params
      );

      const totalFeedbacks = toolStats.rows.reduce((sum, row) => sum + row.total, 0);
      if (totalFeedbacks === 0) return false;

      const suggestions = await pool.query(
        `SELECT tool_name, suggestion
         FROM agent_memory.tool_feedback
         WHERE suggestion IS NOT NULL AND suggestion != ''
         ${dateFilter}
         ORDER BY created_at DESC
         LIMIT 50`,
        params
      );

      const taskStats = await pool.query(
        `SELECT
           count(*)::int AS total_sessions,
           count(*) FILTER (WHERE overall_success = true)::int AS success_count
         FROM agent_memory.task_feedback
         WHERE 1=1 ${dateFilter}`,
        params
      );

      const now = new Date().toISOString().split("T")[0];
      const reportFrom = lastReportAt ? lastReportAt.split("T")[0] : "전체";
      const lines = [];

      lines.push("# 도구 유용성 피드백 리포트");
      lines.push("");
      lines.push(`생성일: ${now}`);
      lines.push(`기간: ${reportFrom} ~ ${now}`);
      lines.push(`전체 피드백 수: ${totalFeedbacks}건`);
      lines.push("");
      lines.push("## 도구별 통계");
      lines.push("");
      lines.push("| 도구 | 피드백 수 | 관련성 | 충분성 | 샘플링 | 자발적 | 경고 |");
      lines.push("|------|-----------|--------|--------|--------|--------|------|");

      for (const row of toolStats.rows) {
        const relevantPct = row.total > 0 ? Math.round((row.relevant_count / row.total) * 100) : 0;
        const sufficientPct = row.total > 0 ? Math.round((row.sufficient_count / row.total) * 100) : 0;
        const warnings = [];

        if (row.total < 10) {
          warnings.push("데이터 부족");
        } else {
          if (relevantPct < 50) warnings.push("관련성 낮음");
          if (sufficientPct < 50) warnings.push("충분성 낮음");
        }

        lines.push(
          `| ${row.tool_name} | ${row.total} | ${relevantPct}% | ${sufficientPct}% ` +
          `| ${row.sampled_count} | ${row.voluntary_count} | ${warnings.length > 0 ? warnings.join(", ") : "-"} |`
        );
      }

      if (suggestions.rows.length > 0) {
        lines.push("");
        lines.push("## 주요 개선 제안");
        lines.push("");

        const grouped = {};
        for (const suggestion of suggestions.rows) {
          if (!grouped[suggestion.tool_name]) grouped[suggestion.tool_name] = [];
          grouped[suggestion.tool_name].push(suggestion.suggestion);
        }

        for (const [toolName, toolSuggestions] of Object.entries(grouped)) {
          lines.push(`### ${toolName}`);
          for (const suggestion of toolSuggestions.slice(0, 5)) {
            lines.push(`- ${suggestion}`);
          }
          lines.push("");
        }
      }

      const taskSummary = taskStats.rows[0];
      if (taskSummary && taskSummary.total_sessions > 0) {
        const successRate = Math.round((taskSummary.success_count / taskSummary.total_sessions) * 100);
        lines.push("## 작업 레벨 통계");
        lines.push("");
        lines.push("| 지표 | 값 |");
        lines.push("|------|-----|");
        lines.push(`| 평가된 세션 수 | ${taskSummary.total_sessions} |`);
        lines.push(`| 성공 비율 | ${successRate}% |`);
        lines.push("");
      }

      const fs = await import("fs");
      const path = await import("path");
      const reportsDir = path.default.join(process.cwd(), "docs", "reports");
      const reportPath = path.default.join(reportsDir, "tool-feedback-report.md");

      await fs.promises.mkdir(reportsDir, { recursive: true });
      await fs.promises.writeFile(reportPath, lines.join("\n"), "utf-8");
      this.logInfo(`[MemoryConsolidator] Feedback report generated: ${reportPath}`);

      try {
        if (redisClient && redisClient.status === "ready") {
          await redisClient.set(LAST_REPORT_KEY, new Date().toISOString());
        }
      } catch (err) {
        this.logWarn(`[MemoryConsolidator] Redis lastReportAt write failed: ${err.message}`);
      }

      return true;
    } catch (err) {
      this.logWarn(`[MemoryConsolidator] Feedback report generation failed: ${err.message}`);
      return false;
    }
  }

  async _collectStaleFragments() {
    const pool = this.getPrimaryPool();
    if (!pool) return [];

    const result = await pool.query(
      `SELECT id, content, type, verified_at,
              EXTRACT(DAY FROM NOW() - verified_at)::int AS days_since_verification
       FROM agent_memory.fragments
       WHERE (type = 'procedure' AND verified_at < NOW() - INTERVAL '30 days')
          OR (type = 'fact'      AND verified_at < NOW() - INTERVAL '60 days')
          OR (type = 'decision'  AND verified_at < NOW() - INTERVAL '90 days')
          OR (type NOT IN ('procedure', 'fact', 'decision') AND verified_at < NOW() - INTERVAL '60 days')
       ORDER BY days_since_verification DESC
       LIMIT 20`
    );

    return result.rows.map(row => ({
      id: row.id,
      content: row.content.substring(0, 80) + (row.content.length > 80 ? "..." : ""),
      type: row.type,
      verified_at: row.verified_at,
      days_since_verification: row.days_since_verification
    }));
  }

  async _purgeStaleReflections() {
    const policy = this.memoryConfig.reflectionPolicy || {};
    const maxDays = Number(policy.maxAgeDays) || 30;
    const maxImportance = Number(policy.maxImportance) || 0.3;
    const keepCount = Number(policy.keepPerType) || 5;
    const maxDelete = Number(policy.maxDeletePerCycle) || 30;

    const result = await this.query(
      "system",
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (PARTITION BY type ORDER BY importance DESC, created_at DESC) AS rn
         FROM ${this.schema}.fragments
         WHERE topic = 'session_reflect'
       )
       DELETE FROM ${this.schema}.fragments
       WHERE id IN (
         SELECT ranked.id FROM ranked
         JOIN ${this.schema}.fragments fragments ON fragments.id = ranked.id
         WHERE ranked.rn > $1
           AND fragments.importance < $2
           AND fragments.created_at < NOW() - make_interval(days => $3)
           AND fragments.is_anchor = FALSE
           AND fragments.ttl_tier != 'permanent'
         LIMIT $4
       )`,
      [keepCount, maxImportance, maxDays, maxDelete],
      "write"
    );

    if (result.rowCount > 0) {
      this.logInfo(`[MemoryConsolidator] Purged ${result.rowCount} stale session_reflect fragments`);
    }

    return result.rowCount;
  }
}
