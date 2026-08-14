#!/usr/bin/env node
// hooks/scripts/cap-banner.mjs
// PostToolUse hook (matcher: Read|Grep|Glob|LS) — runtime cap counters.
//
// For every read-only tool call inside a subagent session, records the call
// on the disk-backed cap state and injects the banner as additionalContext:
//   [cap: N/MAX]
//   [⚠ CAP WARNING: k call(s) remaining…]
//   [⚠ CAP REACHED (N/MAX): your NEXT response MUST be a return…]
//   [⚠ REDUNDANT: this is the same grep you ran at call #k…]
// Landing inside the tool-result context makes the counter ground truth for
// the subagent — very hard to ignore (same mechanism as the opencode
// tool.execute.after banners).

import { readHookInput, emitHookOutput, toolKey } from "./lib/hooks-io.mjs";
import { loadConfig, readState } from "./lib/config.mjs";
import { recordReadCall } from "./lib/caps.mjs";

async function main() {
  const input = readHookInput();
  if (readState()?.bypass === true) return;

  const sid = input?.session_id;
  const agentType = input?.agent_type;
  if (!sid || typeof input?.tool_name !== "string") return;

  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return;
  }

  const tierNames = Object.keys(cfg.presets[cfg.activePreset] ?? {});
  if (!tierNames.includes(agentType)) return; // orchestrator: banners come from the guard's self-cap nudge

  let rec;
  try {
    rec = recordReadCall(sid, agentType, toolKey(input.tool_name), input.tool_input, cfg);
  } catch {
    return; // never break a real session on a counter error
  }
  if (!rec) return;

  emitHookOutput("PostToolUse", { additionalContext: rec.banner });
}

main().catch(() => { /* fail-open */ });
