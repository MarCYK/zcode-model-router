// hooks/scripts/lib/config.mjs
// tiers.json loader + persisted state, ported from src/router/config.ts (opencode).
//
// Differences from the opencode version:
// - Plugin root resolves via $CLAUDE_PLUGIN_ROOT (set by zcode for plugin
//   hooks), falling back to the repository layout (hooks/scripts/lib → root).
// - State lives at ~/.zcode/model-router/state.json instead of the opencode
//   config dir. Hooks are separate short-lived processes, so there is no
//   in-process config cache to invalidate — every hook run re-reads from disk.
// - `bypass` is persisted (opencode kept it in plugin-instance memory for the
//   process lifetime; zcode has no long-lived plugin process).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types (documented in JSDoc; plain JS)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TierConfig
 * @property {string} model
 * @property {string} [thoughtLevel]   reasoning variant: high | low | max (per-model)
 * @property {number} [costRatio]
 * @property {string} [color]
 * @property {string} description
 * @property {number} [maxTurns]
 * @property {string[]} whenToUse
 *
 * @typedef {Object.<string, TierConfig>} Preset
 *
 * @typedef {Object} RouterConfig
 * @property {string} activePreset
 * @property {string} [activeMode]
 * @property {Object.<string, Preset>} presets
 * @property {string[]} rules
 * @property {string} defaultTier
 * @property {Object.<string, string[]>} [taskPatterns]
 * @property {Object.<string, {defaultTier: string, description: string, overrideRules?: string[]}>} [modes]
 * @property {Object.<string, string>} [tierPrompts]
 * @property {Object.<string, number>} [tierCaps]
 * @property {{mode?: "off"|"advisory"|"enforced", perTier?: Object.<string, "off"|"advisory"|"enforced">, verify?: {require?: string, requireExplicitDoD?: boolean}, escalate?: {ladder?: string[]}, guard?: {budget?: number, blockScriptWrites?: boolean}}} [enforcement]
 * @property {{testCommand?: string, buildCommand?: string, lintCommand?: string}} [verifyDefaults]
 *
 * @typedef {Object} RouterState
 * @property {string} [activePreset]
 * @property {string} [activeMode]
 * @property {"off"|"advisory"|"enforced"} [enforcementMode]
 * @property {boolean} [bypass]
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getPluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT;
  if (env && env.trim()) return env.trim();
  // hooks/scripts/lib/config.mjs -> plugin root (repo checkout layout)
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function configPath() {
  return join(getPluginRoot(), "tiers.json");
}

export function stateDir() {
  return join(homedir(), ".zcode", "model-router");
}

export function statePath() {
  return join(stateDir(), "state.json");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function resolvePresetName(cfg, requestedPreset) {
  if (cfg.presets[requestedPreset]) return requestedPreset;
  const normalized = requestedPreset.trim().toLowerCase();
  if (!normalized) return undefined;
  return Object.keys(cfg.presets).find((name) => name.toLowerCase() === normalized);
}

export function validateConfig(raw) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tiers.json: expected a JSON object at root");
  }
  const obj = raw;

  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }
  if (typeof obj.presets !== "object" || obj.presets === null || Array.isArray(obj.presets)) {
    throw new Error("tiers.json: 'presets' must be a non-null object");
  }

  for (const [presetName, preset] of Object.entries(obj.presets)) {
    if (typeof preset !== "object" || preset === null || Array.isArray(preset)) {
      throw new Error(`tiers.json: preset '${presetName}' must be an object`);
    }
    for (const [tierName, tier] of Object.entries(preset)) {
      if (typeof tier !== "object" || tier === null) {
        throw new Error(`tiers.json: tier '${presetName}.${tierName}' must be an object`);
      }
      if (typeof tier.model !== "string" || !tier.model) {
        throw new Error(`tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`);
      }
      if (typeof tier.description !== "string") {
        throw new Error(`tiers.json: '${presetName}.${tierName}.description' must be a string`);
      }
      if (!Array.isArray(tier.whenToUse)) {
        throw new Error(`tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`);
      }
    }
  }

  if (!Array.isArray(obj.rules)) {
    throw new Error("tiers.json: 'rules' must be an array of strings");
  }
  if (typeof obj.defaultTier !== "string") {
    throw new Error("tiers.json: 'defaultTier' must be a string");
  }

  if (obj.modes !== undefined) {
    if (typeof obj.modes !== "object" || obj.modes === null || Array.isArray(obj.modes)) {
      throw new Error("tiers.json: 'modes' must be an object");
    }
    for (const [modeName, mode] of Object.entries(obj.modes)) {
      if (typeof mode !== "object" || mode === null) {
        throw new Error(`tiers.json: mode '${modeName}' must be an object`);
      }
      if (typeof mode.defaultTier !== "string") {
        throw new Error(`tiers.json: mode '${modeName}.defaultTier' must be a string`);
      }
      if (typeof mode.description !== "string") {
        throw new Error(`tiers.json: mode '${modeName}.description' must be a string`);
      }
    }
  }

  if (obj.tierCaps !== undefined) {
    if (typeof obj.tierCaps !== "object" || obj.tierCaps === null || Array.isArray(obj.tierCaps)) {
      throw new Error("tiers.json: 'tierCaps' must be an object");
    }
    for (const [tierName, cap] of Object.entries(obj.tierCaps)) {
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
        throw new Error(`tiers.json: tierCaps.'${tierName}' must be a positive integer`);
      }
    }
  }

  if (obj.tierPrompts !== undefined) {
    if (typeof obj.tierPrompts !== "object" || obj.tierPrompts === null || Array.isArray(obj.tierPrompts)) {
      throw new Error("tiers.json: 'tierPrompts' must be an object");
    }
    for (const [tierName, prompt] of Object.entries(obj.tierPrompts)) {
      if (typeof prompt !== "string") {
        throw new Error(`tiers.json: tierPrompts.'${tierName}' must be a string`);
      }
    }
  }

  if (obj.taskPatterns !== undefined) {
    if (typeof obj.taskPatterns !== "object" || obj.taskPatterns === null || Array.isArray(obj.taskPatterns)) {
      throw new Error("tiers.json: 'taskPatterns' must be an object");
    }
    for (const [tierName, patterns] of Object.entries(obj.taskPatterns)) {
      if (!Array.isArray(patterns)) {
        throw new Error(`tiers.json: taskPatterns.'${tierName}' must be an array of strings`);
      }
    }
  }

  if (obj.enforcement !== undefined) {
    if (typeof obj.enforcement !== "object" || obj.enforcement === null || Array.isArray(obj.enforcement)) {
      throw new Error("tiers.json: enforcement must be an object");
    }
    const enforcement = obj.enforcement;
    if (enforcement.mode !== undefined && !["off", "advisory", "enforced"].includes(enforcement.mode)) {
      throw new Error("tiers.json: enforcement.mode must be one of off|advisory|enforced");
    }
    if (enforcement.perTier !== undefined && typeof enforcement.perTier === "object" && enforcement.perTier !== null) {
      for (const [tierName, tierMode] of Object.entries(enforcement.perTier)) {
        if (!["off", "advisory", "enforced"].includes(tierMode)) {
          throw new Error(`tiers.json: enforcement.perTier.${tierName} must be one of off|advisory|enforced`);
        }
      }
    }
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Loader (state overlay, no in-process cache — hooks are one-shot processes)
// ---------------------------------------------------------------------------

export function loadConfig() {
  const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
  const cfg = validateConfig(raw);

  try {
    if (existsSync(statePath())) {
      const state = JSON.parse(readFileSync(statePath(), "utf-8"));
      if (state.activePreset) {
        const resolved = resolvePresetName(cfg, state.activePreset);
        if (resolved) cfg.activePreset = resolved;
      }
      if (state.activeMode && cfg.modes?.[state.activeMode]) {
        cfg.activeMode = state.activeMode;
      }
      if (state.enforcementMode) {
        cfg.enforcement = { ...(cfg.enforcement ?? {}), mode: state.enforcementMode };
      }
    }
  } catch {
    // Ignore state read errors and keep tiers.json defaults
  }

  return cfg;
}

/** Read tiers.json WITHOUT the state overlay (used by sync-agents). */
export function loadRawConfig() {
  return validateConfig(JSON.parse(readFileSync(configPath(), "utf-8")));
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

/** Read current persisted state (or empty object on failure). */
export function readState() {
  try {
    if (existsSync(statePath())) {
      return JSON.parse(readFileSync(statePath(), "utf-8"));
    }
  } catch {
    // ignore
  }
  return {};
}

/** Write state to disk atomically (merges with existing keys). */
export function writeState(patch) {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
  return state;
}
