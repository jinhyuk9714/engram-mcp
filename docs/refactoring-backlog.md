# Refactoring Backlog

## Current Structure

### MemoryManager

`MemoryManager` is now a facade over dedicated write, query, and session services. Public MCP-facing methods stay on the manager, while implementation lives under `lib/memory/manager/`.

### MemoryConsolidator

`MemoryConsolidator` is now a stage orchestrator. The maintenance pipeline lives under `lib/memory/consolidator/` with an explicit order:

- `LifecycleStage`
- `ReshapeStage`
- `LinkingStage`
- `ScoringStage`
- `ContradictionStage`
- `ReportingStage`

## Next Structural Candidates

### ContradictionStage internal split

`ContradictionStage` still owns candidate selection, NLI/Gemini escalation, contradiction resolution, supersession detection, and pending-queue replay in one unit.

If behavior changes start concentrating there, the next split should separate:

- candidate discovery and filtering
- contradiction/supersession resolution policies
- Redis-backed pending queue replay

### ReportingStage internal split

`ReportingStage` still bundles feedback report generation, Redis index pruning, stale-fragment collection, and stale reflection cleanup.

If reporting rules and cleanup cadence diverge, it should split into:

- feedback analytics/report generation
- index hygiene and stale-fragment collection
- reflection-specific cleanup
