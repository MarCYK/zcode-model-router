#!/usr/bin/env node
// hooks/scripts/narration-scan.mjs
// Stop hook — post-hoc narration telemetry.
//
// Scans the just-completed assistant message for progress-narration
// patterns ("Still writing the X…", "Now I'll implement Y…" without the
// artifact). On match, appends a visible banner as additionalContext so the
// pattern surfaces in the UI. Advisory only — hooks cannot modify the
// already-streamed text; this is the same telemetry contract as the
// opencode experimental.text.complete detector, moved to Stop.

import { readHookInput, emitHookOutput } from "./lib/hooks-io.mjs";
import { readState } from "./lib/config.mjs";
import { detectNarration } from "./lib/narration.mjs";

async function main() {
  if (readState()?.bypass === true) return;
  const input = readHookInput();
  const text = input?.last_assistant_message ?? input?.lastAssistantMessage;
  if (typeof text !== "string" || text.length < 20) return;

  const found = detectNarration(text);
  if (found.length === 0) return;

  const quoted = found
    .map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`)
    .join(", ");
  emitHookOutput("Stop", {
    additionalContext: `[⚠ narration detected: ${quoted}]`,
  });
}

main().catch(() => { /* fail-open */ });
