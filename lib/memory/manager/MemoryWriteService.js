import { EmbeddingWorker } from "../EmbeddingWorker.js";
import { getPrimaryPool } from "../../tools/db.js";
import { pushToQueue } from "../../redis.js";
import { logWarn } from "../../logger.js";
import { MEMORY_CONFIG } from "../../../config/memory.js";

export class MemoryWriteService {
  constructor({
    store,
    index,
    search,
    factory,
    embeddingWorkerFactory = () => new EmbeddingWorker()
  }) {
    this.store                  = store;
    this.index                  = index;
    this.search                 = search;
    this.factory                = factory;
    this.embeddingWorkerFactory = embeddingWorkerFactory;
  }

  async remember(params) {
    const scope   = params.scope || "permanent";
    const agentId = params.agentId || "default";
    const keyId   = params._keyId ?? null;

    if (scope === "session" && params.sessionId) {
      const fragment = this.factory.create(params);
      await this.index.addToWorkingMemory(params.sessionId, fragment);

      return {
        id       : fragment.id,
        keywords : fragment.keywords,
        ttl_tier : "session",
        scope    : "session",
        conflicts: []
      };
    }

    const fragment = this.factory.create({
      ...params,
      isAnchor: params.isAnchor || false
    });
    fragment.agent_id = agentId;
    fragment.key_id   = keyId;

    const id = await this.store.insert(fragment);

    await this.index.index({ ...fragment, id }, params.sessionId);

    try {
      await pushToQueue(MEMORY_CONFIG.embeddingWorker.queueKey, { fragmentId: id });
    } catch {
      this.embeddingWorkerFactory().processOrphanFragments(1).catch(err => {
        logWarn(`[MemoryManager] inline embedding failed: ${err.message}`);
      });
    }

    if (fragment.linked_to && fragment.linked_to.length > 0) {
      for (const linkId of fragment.linked_to) {
        await this.store.createLink(id, linkId, "related", agentId).catch(() => {});
      }
    }

    const conflicts = await this._detectConflicts(fragment.content, fragment.topic, id, agentId, keyId);

    await this._autoLinkOnRemember({ ...fragment, id }, agentId).catch(err => {
      console.warn(`[MemoryManager] _autoLinkOnRemember failed: ${err.message}`);
    });

    if (params.supersedes && Array.isArray(params.supersedes)) {
      for (const oldId of params.supersedes) {
        if (oldId === id) continue;
        try {
          await this._supersede(oldId, id, agentId);
        } catch (err) {
          logWarn(`[MemoryManager] supersede ${oldId} failed: ${err.message}`);
        }
      }
    }

    const excludeTypes = new Set(["fact", "procedure", "error"]);
    if (!excludeTypes.has(fragment.type)) {
      await pushToQueue("memory_evaluation", {
        fragmentId: id,
        agentId,
        type   : fragment.type,
        content: fragment.content
      });
    }

    return {
      id,
      keywords : fragment.keywords,
      ttl_tier : fragment.ttl_tier,
      scope    : "permanent",
      conflicts
    };
  }

  async _detectConflicts(content, topic, newId, agentId = "default", keyId = null) {
    try {
      const result = await this.search.search({
        text        : content,
        topic,
        tokenBudget : 500,
        agentId,
        keyId
      });

      const conflicts = [];

      for (const frag of result.fragments) {
        if (frag.id === newId) continue;
        const similarity = frag.similarity || 0;
        if (similarity > 0.8) {
          conflicts.push({
            existing_id     : frag.id,
            existing_content: (frag.content || "").substring(0, 100),
            similarity,
            recommendation : `기존 파편(${frag.id})을 amend 또는 forget 후 재저장 권장`
          });
        }
      }

      return conflicts;
    } catch (err) {
      console.warn(`[MemoryManager] _detectConflicts failed: ${err.message}`);
      return [];
    }
  }

  async _autoLinkOnRemember(_newFragment, _agentId) {
    // GraphLinker가 EmbeddingWorker의 embedding_ready 이벤트 시 처리한다.
  }

  async _supersede(oldId, newId, agentId = "default") {
    await this.store.createLink(oldId, newId, "superseded_by", agentId);

    const pool = getPrimaryPool();
    if (!pool) return;

    await pool.query(
      `UPDATE agent_memory.fragments
       SET valid_to   = NOW(),
           importance = GREATEST(0.05, importance * 0.5)
       WHERE id = $1 AND valid_to IS NULL`,
      [oldId]
    );
  }

  async forget(params) {
    const agentId  = params.agentId || "default";
    const keyId    = params._keyId ?? null;
    let deleted    = 0;
    let protected_ = 0;

    if (params.id) {
      const frag = await this.store.getById(params.id, agentId);
      if (!frag) return { deleted: 0, protected: 0, error: "Fragment not found" };

      if (keyId && frag.key_id !== keyId) {
        return { deleted: 0, protected: 1, reason: "이 파편에 대한 삭제 권한이 없습니다." };
      }

      if (frag.ttl_tier === "permanent" && !params.force) {
        return { deleted: 0, protected: 1, reason: "permanent 파편은 force 옵션 필요" };
      }

      await this.index.deindex(frag.id, frag.keywords, frag.topic, frag.type);
      const ok = await this.store.delete(frag.id, agentId, keyId);
      deleted  = ok ? 1 : 0;
    }

    if (params.topic) {
      const topicIds = await this.index.searchByTopic(params.topic);

      for (const tid of topicIds) {
        const frag = await this.store.getById(tid, agentId);
        if (!frag) continue;

        if (keyId && frag.key_id !== keyId) {
          protected_++;
          continue;
        }

        if (frag.ttl_tier === "permanent" && !params.force) {
          protected_++;
          continue;
        }

        await this.index.deindex(frag.id, frag.keywords, frag.topic, frag.type);
        const ok = await this.store.delete(frag.id, agentId, keyId);
        if (ok) deleted++;
      }
    }

    return { deleted, protected: protected_ };
  }

  async deleteByAgent(agentId) {
    if (!agentId || agentId === "default") {
      throw new Error("Invalid agentId for full deletion");
    }

    const count = await this.store.deleteByAgent(agentId);
    await this.index.clearWorkingMemory(agentId);

    return { deleted: count };
  }

  async link(params) {
    const agentId  = params.agentId || "default";
    const fromFrag = await this.store.getById(params.fromId, agentId);
    const toFrag   = await this.store.getById(params.toId, agentId);

    if (!fromFrag || !toFrag) {
      return { linked: false, error: "One or both fragments not found" };
    }

    const relationType = params.relationType || "related";
    await this.store.createLink(params.fromId, params.toId, relationType, agentId);

    if (relationType === "resolved_by" && toFrag.type === "error" && toFrag.importance > 0.5) {
      await this.store.update(params.toId, {
        importance: 0.5
      }, agentId);
    }

    return { linked: true, relationType };
  }

  async amend(params) {
    if (!params.id) {
      return { updated: false, error: "id is required" };
    }

    const agentId   = params.agentId || "default";
    const keyId     = params._keyId ?? null;
    const existing  = await this.store.getById(params.id, agentId);
    if (!existing) {
      return { updated: false, error: "Fragment not found" };
    }

    if (keyId && existing.key_id !== keyId) {
      return { updated: false, error: "이 파편에 대한 수정 권한이 없습니다." };
    }

    const updates = {};
    if (params.content !== undefined) updates.content = params.content;
    if (params.topic !== undefined) updates.topic = params.topic;
    if (params.keywords !== undefined && Array.isArray(params.keywords)) {
      updates.keywords = params.keywords.map(k => k.toLowerCase());
    }
    if (params.type !== undefined) updates.type = params.type;
    if (params.importance !== undefined) updates.importance = params.importance;
    if (params.isAnchor !== undefined) updates.is_anchor = params.isAnchor;

    const result = await this.store.update(params.id, updates, agentId, keyId, existing);

    if (!result) {
      return { updated: false, error: "Update failed" };
    }

    if (result.merged) {
      return { updated: false, merged: true, existingId: result.existingId };
    }

    await this.index.deindex(existing.id, existing.keywords, existing.topic, existing.type);
    await this.index.index(result);

    return { updated: true, fragment: result };
  }

  async toolFeedback(params) {
    const pool = getPrimaryPool();
    if (!pool) throw new Error("DB pool not available");

    const suggestion  = params.suggestion ? params.suggestion.substring(0, 100) : null;
    const context     = params.context ? params.context.substring(0, 50) : null;
    const triggerType = params.trigger_type || "voluntary";

    const result = await pool.query(
      `INSERT INTO agent_memory.tool_feedback
             (tool_name, relevant, sufficient, suggestion, context, session_id, trigger_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        params.tool_name,
        params.relevant,
        params.sufficient,
        suggestion,
        context,
        params.session_id || null,
        triggerType
      ]
    );

    return {
      id         : result.rows[0].id,
      tool_name  : params.tool_name,
      relevant   : params.relevant,
      sufficient : params.sufficient
    };
  }
}
