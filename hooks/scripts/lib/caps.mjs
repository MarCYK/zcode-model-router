// hooks/scripts/lib/caps.mjs
// Disk-backed subagent cap tracking. Port of src/router/sessions.ts (opencode),
// adapted because zcode hooks are one-shot processes: cap state MUST live on
// disk keyed by session_id (subagents run in child sessions with their own id).
//
// Files (under ~/.zcode/model-router/caps/):
//   <session_id>.json      subagent cap state
//   turn-<session_id>.json orchestrator per-turn read counter

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.mjs";
import { fingerprintToolCall } from "./fingerprint.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fallback caps when tiers.json has no tierCaps block. */
export const DEFAULT_TIER_CAPS = { fast: 8, medium: 5, heavy: 3 };

/** Tools that count against the read-only cap (lowercase; zcode names normalized). */
export const READ_ONLY_TOOLS = new Set(["grep", "read", "glob", "ls"]);

/** Orchestrator self-cap target: direct read-only calls per user turn. */
export const ORCHESTRATOR_TURN_CAP = 2;

// ---------------------------------------------------------------------------
// Cap directive parser
// ---------------------------------------------------------------------------

/** Extract the first `CAP:N` or `CAP:none` directive from a dispatch prompt. */
export function parseCapDirective(text) {
  const m = String(text ?? "").match(/\bCAP\s*:\s*(none|\d+)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  if (raw === "none") return "none";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Cap banner builder (exact port of opencode buildCapBanner)
// ---------------------------------------------------------------------------

/**
 * Build the banner injected as additionalContext after every read-only tool
 * call in a subagent session.
 */
export function buildCapBanner(state, isRedundant, previousCall, tool) {
  const lines = [];
  const capDisplay = state.cap === "none" ? "∞" : String(state.cap);
  lines.push(`[cap: ${state.calls}/${capDisplay}]`);

  if (isRedundant && previousCall !== undefined) {
    lines.push(
      `[⚠ REDUNDANT: this is the same ${tool} you ran at call #${previousCall}. STOP now — repeated reads add no information. Return with DONE/NEED MORE/NEED CONTEXT/SCOPE GROWTH/ESCALATE.]`,
    );
  }

  if (state.cap !== "none") {
    const remaining = state.cap - state.calls;
    if (remaining <= 0) {
      lines.push(
        `[⚠ CAP REACHED (${state.calls}/${state.cap}): your NEXT response MUST be a return — do NOT make another read-only call. Start the response with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.]`,
      );
    } else if (remaining <= 2) {
      lines.push(`[⚠ CAP WARNING: ${remaining} read-only call(s) remaining before forced return]`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Trivial classifier (port of opencode classifyTrivial)
// ---------------------------------------------------------------------------

function normTaskKw(kw) {
  return String(kw).toLowerCase().split("(")[0].split("/")[0].trim();
}

/**
 * Classify a dispatch as "trivial": conservative, tier-gated. Only a `fast`
 * dispatch matching a fast taskPattern with NO medium/heavy signal is trivial.
 */
export function classifyTrivial(dispatchText, tier, cfg) {
  if (tier !== "fast") return false;
  const text = (dispatchText || "").toLowerCase();
  if (!text.trim()) return false;
  const disqualifiers = [...(cfg.taskPatterns?.medium ?? []), ...(cfg.taskPatterns?.heavy ?? [])];
  for (const kw of disqualifiers) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return false;
  }
  const fast = cfg.taskPatterns?.fast ?? [];
  for (const kw of fast) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Disk store
// ---------------------------------------------------------------------------

function capsDir() {
  return join(stateDir(), "caps");
}

function capFile(sessionID) {
  return join(capsDir(), `${sessionID}.json`);
}

function turnFile(sessionID) {
  return join(capsDir(), `turn-${sessionID}.json`);
}

function writeJsonAtomic(p, obj) {
  mkdirSync(capsDir(), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(obj), "utf-8");
  renameSync(tmp, p);
}

function readJson(p, fallback) {
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    // corrupt state = fresh state
  }
  return fallback;
}

/**
 * Initialise (or re-initialise) cap state for a subagent session. Called
 * lazily on the subagent's first read-only tool call — the hook payload gives
 * us agent_type (the tier) but NOT the dispatch prompt, so per-dispatch CAP:N
 * overrides are prompt-level only; the runtime enforces the tier baseline.
 */
export function initSubagentState(sessionID, tier, cfg) {
  const baseline = cfg.tierCaps?.[tier] ?? DEFAULT_TIER_CAPS[tier] ?? 5;
  const state = { tier, cap: baseline, calls: 0, trivial: false, seen: {}, updated: Date.now() };
  writeJsonAtomic(capFile(sessionID), state);
  return state;
}

export function loadCapState(sessionID) {
  const s = readJson(capFile(sessionID), null);
  if (!s || typeof s !== "object") return null;
  return { ...s, seen: s.seen ?? {} };
}

/**
 * Pre-check a read-only call WITHOUT recording it (used by PreToolUse to
 * decide allow/deny before execution). Returns null when the session is not
 * tracked and no tier is given, or when the tool is not read-only.
 */
export function precheckRead(sessionID, tier, tool, args, cfg) {
  const t = String(tool ?? "").toLowerCase();
  if (!READ_ONLY_TOOLS.has(t)) return null;
  let state = loadCapState(sessionID);
  if (!state) {
    if (!tier) return null;
    state = initSubagentState(sessionID, tier, cfg);
  }
  const fp = fingerprintToolCall(t, args);
  const previousCall = state.seen[fp];
  const isRedundant = previousCall !== undefined;
  const wouldBeCall = state.calls + 1;
  const atCap = state.cap !== "none" && wouldBeCall > state.cap;
  return { state, isRedundant, previousCall, wouldBeCall, atCap, fp, tool: t };
}

/**
 * Record a completed read-only call and build its banner (PostToolUse).
 * Returns { state, banner, isRedundant } or null when untracked / not read-only.
 */
export function recordReadCall(sessionID, tier, tool, args, cfg) {
  const pre = precheckRead(sessionID, tier, tool, args, cfg);
  if (!pre) return null;
  const { state, fp } = pre;

  state.calls += 1;
  if (pre.previousCall === undefined) {
    state.seen[fp] = state.calls;
  }
  state.updated = Date.now();
  writeJsonAtomic(capFile(sessionID), state);

  return {
    state,
    banner: buildCapBanner(state, pre.isRedundant, pre.previousCall, pre.tool),
    isRedundant: pre.isRedundant,
  };
}

/** Drop tracking for a session (used by SessionStart GC and tests). */
export function clearSession(sessionID) {
  try {
    if (existsSync(capFile(sessionID))) unlinkSync(capFile(sessionID));
  } catch { /* best-effort */ }
  try {
    if (existsSync(turnFile(sessionID))) unlinkSync(turnFile(sessionID));
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Orchestrator per-turn read counter
// ---------------------------------------------------------------------------

/** Reset the orchestrator's direct read counter (called on UserPromptSubmit). */
export function resetTurnReads(sessionID) {
  writeJsonAtomic(turnFile(sessionID), { reads: 0, updated: Date.now() });
}

/** Increment + return the orchestrator's direct read count for this turn. */
export function bumpTurnReads(sessionID) {
  const cur = readJson(turnFile(sessionID), { reads: 0 });
  const next = { reads: (cur.reads ?? 0) + 1, updated: Date.now() };
  writeJsonAtomic(turnFile(sessionID), next);
  return next.reads;
}

// ---------------------------------------------------------------------------
// GC: remove cap files older than maxAgeMs (called from SessionStart)
// ---------------------------------------------------------------------------

export function gcCapFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
  const dir = capsDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  const now = Date.now();
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > maxAgeMs) {
          unlinkSync(p);
          removed += 1;
        }
      } catch { /* racing delete — fine */ }
    }
  } catch { /* best-effort */ }
  return removed;
}
