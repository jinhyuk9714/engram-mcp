#!/usr/bin/env node

import { main } from "../lib/cli/main.js";

main().catch((err) => {
  const message = err?.message || String(err);
  console.error(`[engram-mcp] ${message}`);
  process.exit(1);
});
