// hooks/scripts/lib/hooks-io.mjs
// zcode hook stdin/stdout contract helpers.
//
// zcode spawns each hook as a separate process and pipes ONE JSON payload on
// stdin. Stdout is parsed as JSON against a STRICT schema — any extra key
// fails validation and the whole hook output is discarded — so emit ONLY the
// recognized keys for the event, or nothing at all (empty output = pass).
//
// stdin payload (verified against the zcode host bundle):
//   { agent_type, session_id, hook_event_name, permission_mode, cwd,
//     transcript_path, tool_name?, tool_input?, tool_use_id?,
//     tool_response? (PostToolUse), last_assistant_message? (Stop) }
//
// stdout (per-event union, all keys optional but name-locked):
//   UserPromptSubmit/SessionStart/PostToolUse/Stop: { hookEventName, additionalContext }
//   PreToolUse: + permissionDecision ("allow"|"ask"|"deny"), permissionDecisionReason

import { readFileSync } from "node:fs";

/** Read the hook payload from stdin. Returns {} on empty/invalid input. */
export function readHookInput() {
  try {
    const raw = readFileSync(0, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Emit a hook result on stdout. Extra keys fail zcode's strict output
 * validation, so this only ever writes the documented keys for each event.
 */
export function emitHookOutput(event, fields = {}) {
  const allowed = {
    PreToolUse: ["additionalContext", "permissionDecision", "permissionDecisionReason"],
    PermissionRequest: ["additionalContext", "permissionDecision", "permissionDecisionReason"],
    PostToolUse: ["additionalContext"],
    PostToolUseFailure: ["additionalContext"],
    UserPromptSubmit: ["additionalContext"],
    SessionStart: ["additionalContext"],
    Stop: ["additionalContext"],
  }[event];
  if (!allowed) return; // unknown event: say nothing, exit clean
  const out = { hookEventName: event };
  for (const key of allowed) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  process.stdout.write(JSON.stringify(out));
}

/** Lowercase tool-name normalizer (zcode tool names are PascalCase). */
export function toolKey(toolName) {
  return String(toolName ?? "").toLowerCase();
}
