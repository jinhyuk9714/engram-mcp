export const SCHEMA = "agent_memory";

export function createConsolidationResults() {
  return {
    ttlTransitions: 0,
    importanceDecay: false,
    expiredDeleted: 0,
    fragmentsSplit: 0,
    duplicatesMerged: 0,
    embeddingsAdded: 0,
    retroLinked: 0,
    utilityUpdated: 0,
    anchorsPromoted: 0,
    contradictionsFound: 0,
    nliResolvedDirectly: 0,
    nliSkippedAsNonContra: 0,
    pendingContradictions: 0,
    feedbackReportGenerated: false,
    gcCandidatesByType: {},
    indexesPruned: false,
    supersessionsDetected: 0,
    stale_fragments: [],
    reflectionsPurged: 0
  };
}
