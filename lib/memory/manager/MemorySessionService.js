import { getPrimaryPool } from "../../tools/db.js";
import { pushToQueuePriority } from "../../redis.js";
import { logWarn } from "../../logger.js";
import { MEMORY_CONFIG } from "../../../config/memory.js";

export class MemorySessionService {
  constructor({ store, index, factory }) {
    this.store   = store;
    this.index   = index;
    this.factory = factory;
  }

  async reflect(params) {
    const fragments  = [];
    const sessionSrc = `session:${params.sessionId || "unknown"}`;
    const agentId    = params.agentId || "default";
    const keyId      = params._keyId ?? null;
    const breakdown  = { summary: 0, decisions: 0, errors: 0, procedures: 0, questions: 0 };

    if (params.sessionId) {
      const consolidated = await this._consolidateSessionFragments(params.sessionId, agentId, keyId);
      if (consolidated) {
        if (!params.summary && consolidated.summary) params.summary = consolidated.summary;
        if (!params.decisions?.length && consolidated.decisions?.length) params.decisions = consolidated.decisions;
        if (!params.errors_resolved?.length && consolidated.errors_resolved?.length) params.errors_resolved = consolidated.errors_resolved;
        if (!params.new_procedures?.length && consolidated.new_procedures?.length) params.new_procedures = consolidated.new_procedures;
        if (!params.open_questions?.length && consolidated.open_questions?.length) params.open_questions = consolidated.open_questions;
      }
    }

    if (params.summary) {
      const summaryItems = Array.isArray(params.summary)
        ? params.summary.filter(item => item && item.trim().length > 0)
        : this.factory.splitAndCreate(params.summary, {
            topic: "session_reflect", type: "fact", source: sessionSrc, agentId
          }).map(fragment => fragment.content);

      for (const item of summaryItems) {
        const fragment = this.factory.create({
          content : item.trim ? item.trim() : item,
          topic   : "session_reflect",
          type    : "fact",
          source  : sessionSrc,
          agentId
        });
        fragment.agent_id = agentId;
        fragment.key_id   = keyId;
        const id = await this.store.insert(fragment);
        await this.index.index({ ...fragment, id }, params.sessionId);
        fragments.push({ id, content: fragment.content, type: "fact", keywords: fragment.keywords });
        breakdown.summary++;
      }
    }

    if (params.decisions && params.decisions.length > 0) {
      for (const decision of params.decisions) {
        if (!decision || decision.trim().length === 0) continue;
        const fragment = this.factory.create({
          content    : decision.trim(),
          topic      : "session_reflect",
          type       : "decision",
          importance : 0.8,
          source     : sessionSrc,
          agentId
        });
        fragment.agent_id = agentId;
        fragment.key_id   = keyId;
        const id = await this.store.insert(fragment);
        await this.index.index({ ...fragment, id }, params.sessionId);
        fragments.push({ id, content: fragment.content, type: "decision", keywords: fragment.keywords });
        breakdown.decisions++;
      }
    }

    if (params.errors_resolved && params.errors_resolved.length > 0) {
      for (const errorText of params.errors_resolved) {
        if (!errorText || errorText.trim().length === 0) continue;
        const fragment = this.factory.create({
          content    : `[해결됨] ${errorText.trim()}`,
          topic      : "session_reflect",
          type       : "error",
          importance : 0.5,
          source     : sessionSrc,
          agentId
        });
        fragment.agent_id = agentId;
        fragment.key_id   = keyId;
        const id = await this.store.insert(fragment);
        await this.index.index({ ...fragment, id }, params.sessionId);
        fragments.push({ id, content: fragment.content, type: "error", keywords: fragment.keywords });
        breakdown.errors++;
      }
    }

    if (params.new_procedures && params.new_procedures.length > 0) {
      for (const procedure of params.new_procedures) {
        if (!procedure || procedure.trim().length === 0) continue;
        const fragment = this.factory.create({
          content    : procedure.trim(),
          topic      : "session_reflect",
          type       : "procedure",
          importance : 0.7,
          source     : sessionSrc,
          agentId
        });
        fragment.agent_id = agentId;
        fragment.key_id   = keyId;
        const id = await this.store.insert(fragment);
        await this.index.index({ ...fragment, id }, params.sessionId);
        fragments.push({ id, content: fragment.content, type: "procedure", keywords: fragment.keywords });
        breakdown.procedures++;
      }
    }

    if (params.open_questions && params.open_questions.length > 0) {
      for (const question of params.open_questions) {
        if (!question || question.trim().length === 0) continue;
        const fragment = this.factory.create({
          content    : `[미해결] ${question.trim()}`,
          topic      : "session_reflect",
          type       : "fact",
          importance : 0.4,
          source     : sessionSrc,
          agentId
        });
        fragment.agent_id = agentId;
        fragment.key_id   = keyId;
        const id = await this.store.insert(fragment);
        await this.index.index({ ...fragment, id }, params.sessionId);
        fragments.push({ id, content: fragment.content, type: "fact", keywords: fragment.keywords });
        breakdown.questions++;
      }
    }

    if (params.task_effectiveness) {
      try {
        await this._saveTaskFeedback(params.sessionId || "unknown", params.task_effectiveness);
        breakdown.task_feedback = true;
      } catch (err) {
        console.warn(`[MemoryManager] task_feedback save failed: ${err.message}`);
        breakdown.task_feedback = false;
      }
    }

    await this._autoLinkSessionFragments(fragments, agentId);

    const queueName = MEMORY_CONFIG.embeddingWorker.queueKey;
    for (const fragment of fragments) {
      if (fragment.id) {
        await pushToQueuePriority(queueName, { fragmentId: fragment.id }).catch(() => {});
      }
    }

    if (params.sessionId) {
      await this.index.clearWorkingMemory(params.sessionId);
    }

    return { fragments, count: fragments.length, breakdown };
  }

  async _saveTaskFeedback(sessionId, effectiveness) {
    const pool = getPrimaryPool();
    if (!pool) return;

    await pool.query(
      `INSERT INTO agent_memory.task_feedback
             (session_id, overall_success, tool_highlights, tool_pain_points)
       VALUES ($1, $2, $3, $4)`,
      [
        sessionId,
        effectiveness.overall_success || false,
        effectiveness.tool_highlights || [],
        effectiveness.tool_pain_points || []
      ]
    );
  }

  async _consolidateSessionFragments(sessionId, agentId = "default", keyId = null) {
    const ids     = await this.index.getSessionFragments(sessionId);
    const wmItems = await this.index.getWorkingMemory(sessionId);
    const rows    = ids?.length > 0 ? await this.store.getByIds(ids, agentId, keyId) : [];
    const allRows = [
      ...(rows || []),
      ...(wmItems || []).map(item => ({
        content: item.content,
        type   : item.type || "fact"
      }))
    ];
    if (!allRows.length) return null;

    const decisions      = [];
    const errorsResolved = [];
    const procedures     = [];
    const openQuestions  = [];
    const summaryParts   = [];

    for (const row of allRows) {
      const content = (row.content || "").trim();
      if (!content) continue;

      switch (row.type) {
        case "decision":
          decisions.push(content.replace(/^\[해결됨\]\s*/i, "").trim());
          break;
        case "error":
          errorsResolved.push(content.replace(/^\[해결됨\]\s*/i, "").trim());
          break;
        case "procedure":
          procedures.push(content);
          break;
        case "fact":
          if (content.includes("[미해결]")) {
            openQuestions.push(content.replace(/^\[미해결\]\s*/i, "").trim());
          } else {
            summaryParts.push(content);
          }
          break;
        default:
          summaryParts.push(content);
      }
    }

    const summary = summaryParts.length > 0
      ? `세션 ${sessionId.substring(0, 8)}... 종합: ${summaryParts.join(" ")}`
      : (decisions.length || errorsResolved.length || procedures.length
        ? `세션 ${sessionId.substring(0, 8)}... 종합: 결정 ${decisions.length}건, 에러 해결 ${errorsResolved.length}건, 절차 ${procedures.length}건`
        : null);

    if (!summary && !decisions.length && !errorsResolved.length && !procedures.length && !openQuestions.length) {
      return null;
    }

    return {
      summary,
      decisions      : [...new Set(decisions)],
      errors_resolved: [...new Set(errorsResolved)],
      new_procedures : [...new Set(procedures)],
      open_questions : [...new Set(openQuestions)]
    };
  }

  async _autoLinkSessionFragments(fragments, agentId = "default") {
    const errors     = fragments.filter(fragment => fragment.type === "error");
    const decisions  = fragments.filter(fragment => fragment.type === "decision");
    const procedures = fragments.filter(fragment => fragment.type === "procedure");

    for (const error of errors) {
      for (const decision of decisions) {
        if (await this._wouldCreateCycle(error.id, decision.id, agentId)) continue;
        await this.store.createLink(error.id, decision.id, "caused_by", agentId).catch(() => {});
      }
    }

    for (const procedure of procedures) {
      for (const error of errors) {
        if (await this._wouldCreateCycle(procedure.id, error.id, agentId)) continue;
        await this.store.createLink(procedure.id, error.id, "resolved_by", agentId).catch(() => {});
      }
    }
  }

  async _wouldCreateCycle(fromId, toId, agentId = "default") {
    try {
      return await this.store.isReachable(toId, fromId, agentId);
    } catch (err) {
      logWarn(`[MemoryManager] Cycle detection failed: ${err.message}`);
      return false;
    }
  }
}
