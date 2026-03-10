# Installation Guide

## One-line usage (recommended)

This is the default path if you want to connect immediately without managing a `.env` first.

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@jinhyuk9714/engram-mcp"]
    }
  }
}
```

```bash
npx -y @jinhyuk9714/engram-mcp
```

- If `DATABASE_URL` or `POSTGRES_*` is already set, Engram MCP uses that database directly.
- If not, it bootstraps a local Docker PostgreSQL instance automatically on macOS and Linux.
- Redis stays off by default, and semantic retrieval turns on when `OPENAI_API_KEY` is present.

---

## Repository quick start (interactive setup script)

```bash
bash scripts/setup.sh

# Compatibility path
# bash setup.sh
```

Guides you through `.env` creation, `npm install`, and DB schema setup step by step. Use this path for local development or HTTP self-hosting.

---

## Manual Installation

## Dependencies

```bash
npm install

# (Optional) If npm install fails on a CUDA 11 system due to onnxruntime-node GPU binding:
# npm install --onnxruntime-node-install-cuda=skip
```

**Note on ONNX Runtime and CUDA:** On systems with CUDA 11 installed, `npm install` may fail during `onnxruntime-node` post-install. Use `npm install --onnxruntime-node-install-cuda=skip` to force CPU-only mode. This project does not require GPU acceleration.

## PostgreSQL Schema

The `pgvector` extension must be installed prior to schema initialization:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Verify with `\dx` in psql. The HNSW index requires pgvector 0.5.0 or later.

**Fresh install:**

```bash
psql -U $POSTGRES_USER -d $POSTGRES_DB -f lib/memory/memory-schema.sql
```

## Upgrade (Existing Installation)

Run migrations in order:

```bash
# Temporal schema: adds valid_from, valid_to, superseded_by columns and indexes
psql $DATABASE_URL -f lib/memory/migration-001-temporal.sql

# Decay idempotency: adds last_decay_at column
psql $DATABASE_URL -f lib/memory/migration-002-decay.sql

# API key management: creates api_keys and api_key_usage tables
psql $DATABASE_URL -f lib/memory/migration-003-api-keys.sql

# API key isolation: adds key_id column to fragments
psql $DATABASE_URL -f lib/memory/migration-004-key-isolation.sql

# GC policy reinforcement: adds auxiliary indexes on utility_score and access_count
psql $DATABASE_URL -f lib/memory/migration-005-gc-columns.sql

# fragment_links constraint: adds superseded_by to relation_type CHECK
psql $DATABASE_URL -f lib/memory/migration-006-superseded-by-constraint.sql
```

> **Upgrading from v1.1.0 or earlier**: If migration-006 is not applied, any operation that creates a `superseded_by` link — `amend`, `memory_consolidate`, and automatic relationship generation in GraphLinker — will fail with a DB constraint error. This migration is mandatory when upgrading an existing database.

```bash
# For models with >2000 dimensions (e.g., Gemini gemini-embedding-001 at 3072 dims) only:
# EMBEDDING_DIMENSIONS=3072 DATABASE_URL=$DATABASE_URL \
#   node lib/memory/migration-007-flexible-embedding-dims.js

# One-time L2 normalization of existing embeddings (safe to re-run; idempotent)
DATABASE_URL=$DATABASE_URL node lib/memory/normalize-vectors.js

# Backfill embeddings for existing fragments (requires embedding API key, one-time)
npm run backfill:embeddings
```

## Environment Variables

```bash
cp .env.example .env
# Edit .env: set DATABASE_URL or POSTGRES_*, ENGRAM_ACCESS_KEY, and other required values
```

`ENGRAM_ACCESS_KEY` is now the canonical authentication variable. The previous authentication env var and custom header names are no longer supported.

For the full environment variable list and examples, see [.env.example](.env.example).

## Running

### stdio MCP server

```bash
npx -y @jinhyuk9714/engram-mcp
```

Inside the repository, this is equivalent:

```bash
node bin/engram-mcp.js
```

### HTTP self-host

```bash
npx -y @jinhyuk9714/engram-mcp serve

# inside the repository
npm start
```

## Tests

```bash
npm test

# Only when PostgreSQL and DATABASE_URL are available
npm run test:db

# To verify Docker auto-bootstrap as well
npm run test:e2e:docker
```

`npm test` covers the local-safe suite. The temporal integration test is intentionally split into `npm run test:db` because it requires a live Postgres connection.

On startup, the HTTP server logs the listening port, authentication status, session TTL, confirms `MemoryEvaluator` worker initialization, and begins NLI model preloading in the background (~30s on first download, ~1-2s from cache). Graceful shutdown on `SIGTERM` / `SIGINT` triggers `AutoReflect` for all active sessions, stops `MemoryEvaluator`, drains the PostgreSQL connection pool, and flushes access statistics.

## Claude Desktop / Claude Code configuration (stdio)

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@jinhyuk9714/engram-mcp"]
    }
  }
}
```

### Injecting your own DB or embedding configuration

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@jinhyuk9714/engram-mcp"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@db.example.com:5432/engram",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### HTTP self-host configuration

```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "http://localhost:57332/mcp",
      "headers": {
        "Authorization": "Bearer ${ENGRAM_ACCESS_KEY}"
      }
    }
  }
}
```

Store the access key in an environment variable; do not commit plaintext credentials. For external access, expose the service through a reverse proxy (TLS termination, rate limiting). Do not publish internal host addresses or port numbers in external documentation.

## Session-start guidance

Add the following to your project instructions or `CLAUDE.md`:

```markdown
## Session Start Rules
- At the start of every conversation, call the `context` tool to load Core Memory and Working Memory.
- Before debugging or writing code, call `recall(keywords=[relevant_keywords], type="error")` to surface related past learnings.
```

`context` returns only high-importance fragments within your token budget, so it injects critical information without polluting the context window. Pairing stdio startup with these project instructions significantly reduces the "amnesia effect" where the AI behaves as if meeting you for the first time each session.

## MCP Protocol Version Negotiation

| Version | Notable Additions |
|---------|------------------|
| `2025-11-25` | Tasks abstraction, long-running operation support |
| `2025-06-18` | Structured tool output, server-driven interaction |
| `2025-03-26` | OAuth 2.1, Streamable HTTP transport |
| `2024-11-05` | Initial release; Legacy SSE transport |

The server advertises all four versions. Clients negotiate the highest mutually supported version during `initialize`.
