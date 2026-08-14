#!/usr/bin/env node
// hooks/scripts/subagent-guard.mjs
// PreToolUse hook (matcher: Read|Grep|Glob|LS) — Layer-1 guard.
//
// Subagent sessions (payload agent_type ∈ tiers):
//   enforced  → deny the call at/over cap or on redundant repeat
//               (permissionDecision:"deny" + return-protocol reason)
//   advisory  → allow + warning additionalContext
// Orchestrator sessions:
//   count direct read-only calls per turn; past the self-cap target emit an
//   advisory nudge. NEVER deny the orchestrator.

import { readHookInput, emitHookOutput, toolKey } from "./lib/hooks-io.mjs";
import { loadConfig, readState } from "./lib/config.mjs";
import { resolveEnforcementMode } from "./lib/enforce.mjs";
import { precheckRead, bumpTurnReads, ORCHESTRATOR_TURN_CAP } from "./lib/caps.mjs";

function denyReason(pre) {
  if (pre.isRedundant) {
    return (
      `[router] REDUNDANT read denied: you already ran this exact ${pre.tool} at call #${pre.previousCall}. ` +
      `Reuse the result you already have. Return now with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.`
    );
  }
  return (
    `[router] CAP REACHED (${pre.state.calls}/${pre.state.cap}): this read-only call exceeds your dispatch budget. ` +
    `Your NEXT response MUST be a return — start it with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.`
  );
}

function advisoryContext(pre) {
  const lines = [];
  if (pre.isRedundant) {
    lines.push(`[⚠ REDUNDANT: this is the same ${pre.tool} you ran at call #${pre.previousCall}. STOP — repeated reads add no information.]`);
  }
  if (pre.atCap) {
    lines.push(`[⚠ CAP REACHED (${pre.state.calls}/${pre.state.cap}): your NEXT response MUST be a return — do NOT make another read-only call.]`);
  } else if (pre.state.cap !== "none" && pre.state.cap - pre.wouldBeCall <= 1) {
    lines.push(`[⚠ CAP WARNING: ${pre.state.cap - pre.wouldBeCall} read-only call(s) remaining before forced return]`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

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
  const isSubagent = tierNames.includes(agentType);
  if (!isSubagent) {
    // Orchestrator: advisory self-cap only.
    try {
      const reads = bumpTurnReads(sid);
      if (reads > ORCHESTRATOR_TURN_CAP) {
        emitHookOutput("PreToolUse", {
          additionalContext:
            `[router] self-cap: ${reads - 1} direct read-only calls already made this turn (target ≤${ORCHESTRATOR_TURN_CAP}). ` +
            `Dispatch @fast for further exploration instead of reading yourself.`,
        });
      }
    } catch { /* best-effort */ }
    return;
  }

  // Subagent: cap/redundancy guard.
  let mode = "advisory";
  try {
    mode = resolveEnforcementMode({ config: cfg, tier: agentType, env: process.env }).mode;
  } catch { /* default advisory */ }
  if (mode === "off") return;

  let pre;
  try {
    pre = precheckRead(sid, agentType, toolKey(input.tool_name), input.tool_input, cfg);
  } catch {
    return; // guard-internal error: never break the session
  }
  if (!pre) return;

  const violation = pre.isRedundant || pre.atCap;
  if (!violation) return;

  if (mode === "enforced") {
    emitHookOutput("PreToolUse", {
      permissionDecision: "deny",
      permissionDecisionReason: denyReason(pre),
    });
  } else {
    const ctx = advisoryContext(pre);
    if (ctx) emitHookOutput("PreToolUse", { additionalContext: ctx });
  }
}

main().catch(() => { /* fail-open: never block a session */ });
