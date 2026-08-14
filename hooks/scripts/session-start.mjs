#!/usr/bin/env node
// hooks/scripts/session-start.mjs
// SessionStart hook — hygiene only: GC cap-state files older than 24h.
// Emits nothing (empty stdout = pass).

import { readHookInput } from "./lib/hooks-io.mjs";
import { gcCapFiles } from "./lib/caps.mjs";

async function main() {
  readHookInput(); // drain stdin
  try {
    gcCapFiles(24 * 60 * 60 * 1000);
  } catch { /* best-effort */ }
}

main().catch(() => { /* fail-open */ });
