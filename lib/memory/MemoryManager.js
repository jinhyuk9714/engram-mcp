/**
 * MemoryManager - 파편 기반 기억 시스템 통합 관리자
 *
 * MCP 도구 핸들러에서 호출되는 단일 진입점.
 * public facade는 유지하고, 구현은 write/query/session 서비스로 위임한다.
 */

import { FragmentStore } from "./FragmentStore.js";
import { FragmentIndex } from "./FragmentIndex.js";
import { FragmentSearch } from "./FragmentSearch.js";
import { FragmentFactory } from "./FragmentFactory.js";
import { MemoryConsolidator } from "./MemoryConsolidator.js";
import { MemoryWriteService } from "./manager/MemoryWriteService.js";
import { MemoryQueryService } from "./manager/MemoryQueryService.js";
import { MemorySessionService } from "./manager/MemorySessionService.js";

let instance = null;

export class MemoryManager {
  constructor(overrides = {}) {
    this.store        = overrides.store ?? new FragmentStore();
    this.index        = overrides.index ?? new FragmentIndex();
    this.search       = overrides.search ?? new FragmentSearch();
    this.factory      = overrides.factory ?? new FragmentFactory();
    this.consolidator = overrides.consolidator ?? new MemoryConsolidator();

    const sharedDeps = {
      store : this.store,
      index : this.index,
      search: this.search,
      factory: this.factory
    };

    this.writeService = overrides.writeService ?? new MemoryWriteService(sharedDeps);
    this.queryService = overrides.queryService ?? new MemoryQueryService(sharedDeps);
    this.sessionService = overrides.sessionService ?? new MemorySessionService(sharedDeps);
  }

  static getInstance() {
    if (!instance) {
      instance = new MemoryManager();
    }
    return instance;
  }

  async remember(params) {
    // Legacy facade keeps the supersedes option on remember while delegating implementation.
    return this.writeService.remember(params);
  }

  async recall(params) {
    return this.queryService.recall(params);
  }

  async forget(params) {
    return this.writeService.forget(params);
  }

  async deleteByAgent(agentId) {
    return this.writeService.deleteByAgent(agentId);
  }

  async link(params) {
    return this.writeService.link(params);
  }

  async amend(params) {
    return this.writeService.amend(params);
  }

  async reflect(params) {
    return this.sessionService.reflect(params);
  }

  async context(params) {
    return this.queryService.context(params);
  }

  async toolFeedback(params) {
    return this.writeService.toolFeedback(params);
  }

  async _saveTaskFeedback(sessionId, effectiveness) {
    return this.sessionService._saveTaskFeedback(sessionId, effectiveness);
  }

  async _consolidateSessionFragments(sessionId, agentId = "default", keyId = null) {
    return this.sessionService._consolidateSessionFragments(sessionId, agentId, keyId);
  }

  async _autoLinkSessionFragments(fragments, agentId = "default") {
    return this.sessionService._autoLinkSessionFragments(fragments, agentId);
  }

  async _supersede(oldId, newId, agentId = "default") {
    // Legacy behavior is unchanged: create a superseded_by link, set valid_to,
    // and clamp importance with GREATEST(0.05, importance * 0.5).
    return this.writeService._supersede(oldId, newId, agentId);
  }

  async fragmentHistory(params) {
    return this.queryService.fragmentHistory(params);
  }

  async graphExplore(params) {
    return this.queryService.graphExplore(params);
  }

  async consolidate() {
    return this.consolidator.consolidate();
  }

  async stats() {
    return this.consolidator.getStats();
  }
}
