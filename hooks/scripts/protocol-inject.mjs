#!/usr/bin/env node
// hooks/scripts/protocol-inject.mjs
// UserPromptSubmit hook — injects the delegation protocol into the
// conversation as additionalContext on every user message, and resets the
// orchestrator's per-turn read counter.
//
// Registered without a matcher (fires on every user prompt).

import { readHookInput, emitHookOutput } from "./lib/hooks-io.mjs";
import { loadConfig, readState } from "./lib/config.mjs";
import { assembleSystemPrompt } from "./lib/protocol.mjs";
import { resolveEnforcementMode } from "./lib/enforce.mjs";
import { resetTurnReads } from "./lib/caps.mjs";

async function main() {
  const input = readHookInput();
  const sid = input?.session_id;
  if (sid) {
    try {
      resetTurnReads(sid);
    } catch { /* never break a real session */ }
  }

  if (readState()?.bypass === true) return; // /bypass on: no injection

  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return; // broken tiers.json: inject nothing rather than corrupt context
  }

  let enfOn = false;
  try {
    enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
  } catch { /* default advisory */ }

  // Skip injection for subagent sessions: subagents must execute, not route.
  const tierNames = Object.keys(cfg.presets[cfg.activePreset] ?? {});
  if (input?.agent_type && tierNames.includes(input.agent_type)) return;

  const protocol = assembleSystemPrompt(cfg, undefined, enfOn);
  emitHookOutput("UserPromptSubmit", { additionalContext: protocol });
}

main().catch(() => { /* fail-open: never block a session */ });
