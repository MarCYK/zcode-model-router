#!/usr/bin/env node
// hooks/scripts/cli.mjs
// Command backend for /tiers /preset /budget /bypass /router. The command
// markdown files tell the model to run this script and relay its output.
//
// Usage: node cli.mjs <tiers|preset|budget|bypass|router> [args]

import { loadConfig, readState, writeState, resolvePresetName, getPluginRoot } from "./lib/config.mjs";
import { getActiveTiers } from "./lib/protocol.mjs";
import { resolveEnforcementMode } from "./lib/enforce.mjs";
import { join } from "node:path";

function buildTiersOutput(cfg) {
  const tiers = getActiveTiers(cfg);
  const lines = [`# Model Delegation Tiers`, `Active preset: **${cfg.activePreset}**\n`];
  for (const [name, tier] of Object.entries(tiers)) {
    const tl = tier.thoughtLevel ? ` @${tier.thoughtLevel}` : "";
    lines.push(`## @${name} -> \`${tier.model}\`${tl} (${tier.costRatio ?? "?"}x)`);
    lines.push(tier.description);
    lines.push(`maxTurns: ${tier.maxTurns ?? "default"} | read-only cap: ${cfg.tierCaps?.[name] ?? "default"}`);
    lines.push(`Use when: ${tier.whenToUse.join(", ")}\n`);
  }
  lines.push("## Delegation Rules");
  (cfg.rules ?? []).forEach((r) => lines.push(`- ${r}`));
  lines.push(`\nDefault tier: @${cfg.defaultTier}`);
  lines.push(`Active mode: ${cfg.activeMode ?? "normal"}`);
  lines.push(`\nAvailable presets: ${Object.keys(cfg.presets).join(", ")}`);
  lines.push("Switch with: `/preset <name>` (then run `node scripts/sync-agents.mjs` and restart the session)");
  lines.push("Edit `tiers.json` at the plugin root to customize.");
  return lines.join("\n");
}

function buildPresetOutput(cfg, args) {
  const requested = args.trim();
  if (!requested) {
    const lines = ["# Available Presets\n"];
    for (const [name, tiers] of Object.entries(cfg.presets)) {
      const active = name === cfg.activePreset ? " <- active" : "";
      const models = Object.entries(tiers)
        .map(([tier, t]) => `${tier}: ${t.model}${t.thoughtLevel ? `@${t.thoughtLevel}` : ""}`)
        .join(", ");
      lines.push(`- **${name}**${active}: ${models}`);
    }
    lines.push(`\nSwitch with: \`/preset <name>\``);
    return lines.join("\n");
  }

  const resolved = resolvePresetName(cfg, requested);
  if (!resolved) {
    return `Unknown preset: "${requested}". Available: ${Object.keys(cfg.presets).join(", ")}`;
  }

  writeState({ activePreset: resolved });
  const tiers = cfg.presets[resolved];
  const models = Object.entries(tiers)
    .map(([tier, t]) => `  @${tier} -> ${t.model}${t.thoughtLevel ? ` @${t.thoughtLevel}` : ""}`)
    .join("\n");
  return [
    `Preset switched to **${resolved}**.`,
    "",
    models,
    "",
    "Persisted in ~/.zcode/model-router/state.json.",
    "IMPORTANT: agent files are static in zcode — run this now so new dispatches use the new models:",
    "```bash",
    `node "${join(getPluginRoot(), "scripts", "sync-agents.mjs")}"`,
    "```",
    "Then restart the session (or start a new one) for the regenerated subagents to load.",
    "System prompt delegation rules update on the next user message.",
  ].join("\n");
}

function buildBudgetOutput(cfg, args) {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) {
    return 'No modes configured in tiers.json. Add a "modes" section to enable budget mode.';
  }

  const requested = args.trim().toLowerCase();
  const currentMode = cfg.activeMode || "normal";

  if (!requested) {
    const lines = ["# Routing Modes\n"];
    for (const [name, mode] of Object.entries(modes)) {
      const active = name === currentMode ? " <- active" : "";
      lines.push(`- **${name}**${active}: ${mode.description} (default tier: @${mode.defaultTier})`);
    }
    lines.push(`\nSwitch with: \`/budget <mode>\``);
    return lines.join("\n");
  }

  if (modes[requested]) {
    writeState({ activeMode: requested });
    const mode = modes[requested];
    return [
      `Routing mode switched to **${requested}**.`,
      "",
      mode.description,
      `Default tier: @${mode.defaultTier}`,
      ...(mode.overrideRules?.length ? ["", "Active rules:", ...mode.overrideRules.map((r) => `- ${r}`)] : []),
      "",
      "Mode change takes effect on the next user message (delegation protocol is re-injected per prompt).",
    ].join("\n");
  }

  return `Unknown mode: "${requested}". Available: ${Object.keys(modes).join(", ")}`;
}

function buildBypassOutput(cfg, args) {
  const arg = args.trim().toLowerCase();
  const current = readState()?.bypass === true;
  const next = arg === "on" ? true : arg === "off" ? false : !current;
  writeState({ bypass: next });
  const desc = next
    ? "Model-router is **bypassed**. Delegation protocol injection, cap banners, guard enforcement, and narration detection are disabled. Run `/bypass off` to re-enable."
    : "Model-router is **active**. Delegation protocol and all enforcement rules are in effect.";
  return `# Bypass: ${next ? "ON" : "OFF"}\n\n${desc}`;
}

function buildRouterOutput(cfg, args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  if (sub === "enforce") {
    const mode = (tokens[1] ?? "").toLowerCase();
    if (mode === "off" || mode === "advisory" || mode === "enforced") {
      writeState({ enforcementMode: mode });
      const desc =
        mode === "off"
          ? "All router hooks no-op (byte-for-byte unchanged sessions)."
          : mode === "advisory"
            ? "Guard evaluates and surfaces banners but never hard-blocks."
            : "Guard hard-blocks subagent read-only calls that violate cap / redundancy policy.";
      return [
        `Enforcement mode set to **${mode}** and persisted.`,
        "",
        desc,
        "",
        "Note: the MODEL_ROUTER_ENFORCE env var, when set to 0 or 1, overrides this setting.",
      ].join("\n");
    }
    const current = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
    return [
      `Current enforcement mode: **${current}**`,
      "",
      "Usage: `/router enforce <off|advisory|enforced>`",
    ].join("\n");
  }
  const current = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
  const bypass = readState()?.bypass === true ? "ON (all hooks no-op)" : "off";
  return [
    `# Model Router`,
    `Enforcement: **${current}** | Bypass: **${bypass}**`,
    "",
    "Commands:",
    "- `/router enforce <off|advisory|enforced>` — set enforcement level (persisted)",
    "- `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`",
  ].join("\n");
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = rest.join(" ");
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`[router] config error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  switch (cmd) {
    case "tiers":
      console.log(buildTiersOutput(cfg));
      break;
    case "preset":
      console.log(buildPresetOutput(cfg, args));
      break;
    case "budget":
      console.log(buildBudgetOutput(cfg, args));
      break;
    case "bypass":
      console.log(buildBypassOutput(cfg, args));
      break;
    case "router":
    default:
      console.log(buildRouterOutput(cfg, args));
      break;
  }
}

main();
