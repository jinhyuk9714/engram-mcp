export function getConsolidateIntervalMs(env = process.env) {
  return parseInt(env.CONSOLIDATE_INTERVAL_MS || "21600000", 10);
}

export function registerRecurringJobs({
  env = process.env,
  logDir,
  setIntervalFn = setInterval,
  cleanupExpiredSessions,
  cleanupExpiredOAuthData,
  getSessionCounts,
  updateSessionCounts,
  saveAccessStats,
  memoryManagerFactory,
  consoleImpl = console
}) {
  const sessionCleanup = setIntervalFn(cleanupExpiredSessions, 5 * 60 * 1000);
  const oauthCleanup = setIntervalFn(cleanupExpiredOAuthData, 5 * 60 * 1000);

  consoleImpl.log("Session cleanup: Running every 5 minutes");

  const sessionMetrics = setIntervalFn(() => {
    const { streamable, legacy } = getSessionCounts();
    updateSessionCounts(streamable, legacy);
  }, 60 * 1000);

  consoleImpl.log("Metrics: Session counts updated every minute");

  const accessStats = setIntervalFn(() => saveAccessStats(logDir), 10 * 60 * 1000);
  consoleImpl.log("Access stats: Saving every 10 minutes");

  const consolidateIntervalMs = getConsolidateIntervalMs(env);
  const consolidate = setIntervalFn(async () => {
    try {
      const mm = memoryManagerFactory();
      const result = await mm.consolidate();
      consoleImpl.log(`[Consolidate] done: expired=${result.expiredDeleted}, decay=${result.importanceDecay}, merged=${result.duplicatesMerged}`);
    } catch (err) {
      consoleImpl.error(`[Consolidate] failed: ${err.message}`);
    }
  }, consolidateIntervalMs);
  consolidate.unref?.();
  consoleImpl.log(`Consolidate: Running every ${consolidateIntervalMs / 3600000}h`);

  const embeddingBackfill = setIntervalFn(async () => {
    try {
      const mm = memoryManagerFactory();
      const count = await mm.store.generateMissingEmbeddings(20);
      if (count > 0) {
        consoleImpl.log(`[EmbeddingBackfill] Generated ${count} embeddings`);
      }
    } catch (err) {
      consoleImpl.error(`[EmbeddingBackfill] failed: ${err.message}`);
    }
  }, 30 * 60_000);
  embeddingBackfill.unref?.();
  consoleImpl.log("EmbeddingBackfill: Running every 30min (batch 20)");

  return {
    sessionCleanup,
    oauthCleanup,
    sessionMetrics,
    accessStats,
    consolidate,
    embeddingBackfill,
    consolidateIntervalMs
  };
}
