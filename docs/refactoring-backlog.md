# Refactoring Backlog

## Next Structural Candidates

### MemoryManager

`MemoryManager` still mixes write commands (`remember`, `amend`, `forget`), read queries (`recall`, `context`, `fragmentHistory`, `graphExplore`), and session reflection workflows (`reflect`, `_consolidateSessionFragments`, `_autoLinkSessionFragments`).

A follow-up refactor should split it into:

- command-oriented memory writes
- query-oriented retrieval/context services
- session reflection/orchestration services

### MemoryConsolidator

`MemoryConsolidator` remains a long stage pipeline with duplicate merging, TTL transitions, contradiction handling, supersession detection, feedback generation, and stale-fragment cleanup in one class.

A follow-up refactor should move each maintenance stage behind a named step interface so the pipeline order is explicit, easier to test in isolation, and easier to disable or run selectively.
