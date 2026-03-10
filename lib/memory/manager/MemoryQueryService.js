import { getPrimaryPool } from "../../tools/db.js";
import { MEMORY_CONFIG } from "../../../config/memory.js";

export class MemoryQueryService {
  constructor({ store, index, search }) {
    this.store  = store;
    this.index  = index;
    this.search = search;
  }

  async recall(params) {
    const agentId       = params.agentId || "default";
    const fragmentCount = params.fragmentCount || 0;
    const keyId         = params._keyId ?? null;
    const anchorTime    = params.anchorTime || Date.now();

    const result = await this.search.search({
      keywords          : params.keywords || [],
      topic             : params.topic,
      type              : params.type,
      text              : params.text,
      tokenBudget       : params.tokenBudget || 1000,
      minImportance     : params.minImportance,
      includeSuperseded : params.includeSuperseded || false,
      fragmentCount,
      anchorTime,
      agentId,
      keyId,
      ...(params.isAnchor !== undefined ? { isAnchor: params.isAnchor } : {})
    });

    const shouldIncludeLinks = params.includeLinks !== false;
    if (shouldIncludeLinks && result.fragments.length > 0) {
      const existingIds = new Set(result.fragments.map(f => f.id));
      const fromIds     = result.fragments.map(f => f.id);
      const linkedFrags = await this.store.getLinkedFragments(
        fromIds,
        params.linkRelationType || null,
        agentId
      );

      for (const fragment of linkedFrags) {
        if (!existingIds.has(fragment.id)) {
          result.fragments.push(fragment);
          existingIds.add(fragment.id);
        }
      }
      result.count = result.fragments.length;
    }

    const { importanceWeight, recencyWeight, semanticWeight, recencyHalfLifeDays } = MEMORY_CONFIG.ranking;
    result.fragments.sort((a, b) => {
      const scoreOf = (fragment) => {
        const importance = fragment.importance || 0;
        const parsed     = fragment.created_at ? new Date(fragment.created_at).getTime() : NaN;
        const createdAt  = Number.isFinite(parsed) ? parsed : Date.now();
        const distDays   = Math.abs(anchorTime - createdAt) / 86400000;
        const proximity  = Math.pow(2, -distDays / (recencyHalfLifeDays || 30));
        const similarity = fragment.similarity || 0;
        return importance * (importanceWeight || 0.4)
             + proximity  * (recencyWeight || 0.3)
             + similarity * (semanticWeight || 0.3);
      };
      return scoreOf(b) - scoreOf(a);
    });

    const staleThresholds = MEMORY_CONFIG.staleThresholds;
    const now             = Date.now();

    for (const fragment of result.fragments) {
      const staleDays  = staleThresholds[fragment.type] ?? staleThresholds.default;
      const verifiedAt = fragment.verified_at ? new Date(fragment.verified_at).getTime() : null;
      const daysSince  = verifiedAt
        ? Math.floor((now - verifiedAt) / 86400000)
        : staleDays + 1;

      if (daysSince >= staleDays) {
        fragment.metadata = {
          ...(fragment.metadata || {}),
          stale  : true,
          warning: `[STALE_WARNING] 이 ${fragment.type} 정보는 ${staleDays}일 이상 검증되지 않았습니다. (${daysSince}일 경과)`,
          days_since_verification: daysSince
        };
      }
    }

    if (params.threshold !== undefined) {
      result.fragments = result.fragments.filter(
        fragment => fragment.similarity === undefined || fragment.similarity >= params.threshold
      );
      result.count = result.fragments.length;
    }

    const pageSize = Math.min(
      params.pageSize || MEMORY_CONFIG.pagination?.defaultPageSize || 20,
      MEMORY_CONFIG.pagination?.maxPageSize || 50
    );

    let offset     = 0;
    let anchorSnap = params.anchorTime || Date.now();
    if (params.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(params.cursor, "base64url").toString());
        offset     = decoded.offset || 0;
        anchorSnap = decoded.anchorTime || anchorSnap;
      } catch {}
    }

    const totalCount = result.fragments.length;
    const paged      = result.fragments.slice(offset, offset + pageSize);
    const hasMore    = offset + pageSize < totalCount;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ offset: offset + pageSize, anchorTime: anchorSnap })).toString("base64url")
      : null;

    result.fragments  = paged;
    result.count      = paged.length;
    result.totalCount = totalCount;
    result.nextCursor = nextCursor;
    result.hasMore    = hasMore;

    return result;
  }

  async context(params) {
    const tokenBudget    = params.tokenBudget || 2000;
    const types          = [...(params.types || ["preference", "error", "procedure", "decision"])];
    const coreBudget     = 1500;
    const wmBudget       = 800;
    const coreCharBudget = coreBudget * 4;
    const typeFragMap    = new Map();
    const agentId        = params.agentId || "default";

    for (const type of types) {
      const result = await this.recall({
        type,
        tokenBudget : Math.max(250, Math.floor(coreBudget / types.length)),
        minImportance: 0.3,
        isAnchor    : false,
        agentId
      });
      typeFragMap.set(type, result.fragments);
    }

    const reflectResult = await this.recall({
      topic       : "session_reflect",
      tokenBudget : 300,
      minImportance: 0.3,
      isAnchor    : false,
      agentId
    });
    if (reflectResult.fragments.length > 0) {
      typeFragMap.set("session_reflect", reflectResult.fragments);
      types.push("session_reflect");
    }

    const guaranteed = new Map();
    const seen       = new Set();
    let usedChars    = 0;

    for (const type of types) {
      const fragments = typeFragMap.get(type) || [];
      if (fragments.length > 0) {
        const top     = fragments[0];
        const content = top.content || "";
        guaranteed.set(type, [top]);
        seen.add(top.id);
        usedChars += content.length;
      }
    }

    const extras = [];
    for (const type of types) {
      const fragments = typeFragMap.get(type) || [];
      for (let i = 1; i < fragments.length; i++) {
        if (!seen.has(fragments[i].id)) {
          extras.push(fragments[i]);
          seen.add(fragments[i].id);
        }
      }
    }
    extras.sort((a, b) => (b.importance || 0) - (a.importance || 0));

    const maxCore      = MEMORY_CONFIG.contextInjection?.maxCoreFragments || 15;
    const typeSlots    = MEMORY_CONFIG.contextInjection?.typeSlots || {};
    const typeCounters = {};
    let totalAdded     = 0;

    for (const [, fragments] of guaranteed) {
      totalAdded += fragments.length;
    }

    for (const [type, fragments] of guaranteed) {
      typeCounters[type] = fragments.length;
    }

    for (const fragment of extras) {
      if (totalAdded >= maxCore) break;

      const typeKey = fragment.type || "general";
      const typeMax = typeSlots[typeKey] || 5;
      const current = typeCounters[typeKey] || 0;
      if (current >= typeMax) continue;

      const cost = (fragment.content || "").length;
      if (usedChars + cost > coreCharBudget) {
        const remaining = coreCharBudget - usedChars;
        if (remaining > 80) {
          const truncated = {
            ...fragment,
            content: fragment.content.substring(0, remaining - 3) + "..."
          };
          const typeArr = guaranteed.get(typeKey) || [];
          typeArr.push(truncated);
          guaranteed.set(typeKey, typeArr);
          usedChars += remaining;
          typeCounters[typeKey] = (typeCounters[typeKey] || 0) + 1;
          totalAdded++;
        }
        break;
      }

      const typeArr = guaranteed.get(typeKey) || [];
      typeArr.push(fragment);
      guaranteed.set(typeKey, typeArr);
      usedChars += cost;
      typeCounters[typeKey] = (typeCounters[typeKey] || 0) + 1;
      totalAdded++;
    }

    const coreFragments = [];
    for (const type of types) {
      const fragments = guaranteed.get(type) || [];
      coreFragments.push(...fragments);
    }

    let wmFragments = [];
    let wmChars     = 0;

    if (params.sessionId) {
      const wmItems      = (await this.index.getWorkingMemory(params.sessionId)).reverse();
      const wmCharBudget = wmBudget * 4;
      const maxWm        = MEMORY_CONFIG.contextInjection?.maxWmFragments || 10;

      for (const item of wmItems) {
        if (item.is_anchor) continue;
        if (wmFragments.length >= maxWm) break;
        const cost = (item.content || "").length;
        if (wmChars + cost > wmCharBudget) break;
        wmFragments.push(item);
        wmChars += cost;
      }
    }

    let anchorFragments = [];
    try {
      const pool = getPrimaryPool();
      if (pool) {
        const anchorResult = await pool.query(
          `SELECT id, content, type, topic, importance
             FROM agent_memory.fragments
            WHERE is_anchor = TRUE
              AND valid_to IS NULL
            ORDER BY importance DESC
            LIMIT 10`
        );
        anchorFragments = anchorResult.rows;
      }
    } catch (err) {
      console.warn(`[MemoryManager] anchor load failed: ${err.message}`);
    }

    const lines = [];

    if (anchorFragments.length > 0) {
      lines.push("[ANCHOR MEMORY]");
      for (const fragment of anchorFragments) {
        lines.push(`- ${fragment.content}`);
      }
    }

    const coreSections = {};
    for (const fragment of coreFragments) {
      const key = fragment.type || "general";
      if (!coreSections[key]) coreSections[key] = [];
      coreSections[key].push(fragment.content);
    }

    if (Object.keys(coreSections).length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("[CORE MEMORY]");
      for (const [type, contents] of Object.entries(coreSections)) {
        lines.push(`[${type.toUpperCase()}]`);
        for (const content of contents) {
          lines.push(`- ${content}`);
        }
      }
    }

    if (wmFragments.length > 0) {
      lines.push("");
      lines.push("[WORKING MEMORY]");
      for (const fragment of wmFragments) {
        const label = fragment.type ? `[${fragment.type.toUpperCase()}]` : "";
        lines.push(`- ${label} ${fragment.content}`);
      }
    }

    try {
      const { SessionActivityTracker } = await import("../SessionActivityTracker.js");
      const unreflected = await SessionActivityTracker.getUnreflectedSessions(3);
      if (unreflected.length > 0) {
        lines.push("");
        lines.push("[SYSTEM HINT]");
        lines.push(`- 미반영 세션 ${unreflected.length}개 감지. 세션 종료 전 reflect()를 호출하면 학습 내용이 보존됩니다.`);
      }
    } catch {}

    const anchorChars  = anchorFragments.reduce((sum, fragment) => sum + (fragment.content || "").length, 0);
    const coreTokens   = Math.ceil(usedChars / 4);
    const wmTokens     = Math.ceil(wmChars / 4);
    const anchorTokens = Math.ceil(anchorChars / 4);

    return {
      fragments    : [...anchorFragments, ...coreFragments, ...wmFragments],
      totalTokens  : anchorTokens + coreTokens + wmTokens,
      count        : anchorFragments.length + coreFragments.length + wmFragments.length,
      anchorTokens,
      coreTokens,
      wmTokens,
      wmCount      : wmFragments.length,
      anchorCount  : anchorFragments.length,
      injectionText: lines.join("\n"),
      tokenBudget
    };
  }

  async fragmentHistory(params) {
    if (!params.id) {
      return { error: "id is required" };
    }

    const agentId = params.agentId || "default";
    return this.store.getHistory(params.id, agentId);
  }

  async graphExplore(params) {
    if (!params.startId) {
      return { error: "startId is required" };
    }

    const agentId = params.agentId || "default";
    const nodes   = await this.store.getRCAChain(params.startId, agentId);
    const edges   = nodes
      .filter(node => node.relation_type)
      .map(node => ({
        from         : params.startId,
        to           : node.id,
        relation_type: node.relation_type
      }));

    return {
      startId: params.startId,
      nodes,
      edges,
      count: nodes.length
    };
  }
}
