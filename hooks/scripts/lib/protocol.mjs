// hooks/scripts/lib/protocol.mjs
// Delegation-protocol builder, ported from src/router/protocol.ts (opencode).
//
// Adaptations for zcode:
// - Delegation goes through the native Agent tool: Agent(subagent_type=...).
//   (opencode used Task(subagent_type=...); zcode aliases Task↔Agent.)
// - Provider fallback chains are dropped (models are static per agent file).
// - The Claude orchestrator prefix is unused at runtime (zcode hook payloads
//   do not expose the orchestrator model); it remains available for tools that
//   DO know the model (sync-agents applies tier prefixes to Claude-backed tiers).

// ---------------------------------------------------------------------------
// Tier / mode helpers
// ---------------------------------------------------------------------------

export function getActiveTiers(cfg) {
  return cfg.presets[cfg.activePreset] ?? Object.values(cfg.presets)[0];
}

export function getActiveMode(cfg) {
  if (!cfg.modes || !cfg.activeMode) return undefined;
  return cfg.modes[cfg.activeMode];
}

// ---------------------------------------------------------------------------
// Cost & taxonomy builders
// ---------------------------------------------------------------------------

export function buildTaskTaxonomy(cfg) {
  if (!cfg.taskPatterns || Object.keys(cfg.taskPatterns).length === 0) return "";
  const lines = ["R:"];
  for (const [tier, patterns] of Object.entries(cfg.taskPatterns)) {
    if (Array.isArray(patterns) && patterns.length > 0) {
      lines.push(`@${tier}→${patterns.join("/")}`);
    }
  }
  return lines.join(" ");
}

/**
 * Multi-phase decomposition hint: teaches the orchestrator to split composite
 * tasks (explore + implement) so the cheapest tier explores and the mid tier
 * executes. Only active in modes without overrideRules (they carry their own).
 */
export function buildDecomposeHint(cfg) {
  const mode = getActiveMode(cfg);
  if (mode?.overrideRules?.length) return "";

  const tiers = getActiveTiers(cfg);
  const entries = Object.entries(tiers);
  if (entries.length < 2) return "";

  const sorted = [...entries].sort(([, a], [, b]) => (a.costRatio ?? 1) - (b.costRatio ?? 1));
  const cheapest = sorted[0]?.[0];
  const mid = sorted[1]?.[0];
  if (!cheapest || !mid) return "";

  return `Multi-phase: prefer explore(@${cheapest})→execute(@${mid}) when phases are separable. Cheapest-first when practical.`;
}

// ---------------------------------------------------------------------------
// Protocol builder
// ---------------------------------------------------------------------------

export function buildDelegationProtocol(cfg) {
  const tiers = getActiveTiers(cfg);

  // Compact tier summary: @name=model/variant(costRatio)
  const tierLine = Object.entries(tiers)
    .map(([name, t]) => {
      const short = t.model.split("/").pop() ?? t.model;
      const v = t.thoughtLevel ? `/${t.thoughtLevel}` : "";
      const c = t.costRatio != null ? `(${t.costRatio}x)` : "";
      return `@${name}=${short}${v}${c}`;
    })
    .join(" ");

  const mode = getActiveMode(cfg);
  const modeSuffix = cfg.activeMode ? ` mode:${cfg.activeMode}` : "";

  const taxonomy = buildTaskTaxonomy(cfg);
  const decompose = buildDecomposeHint(cfg);

  const effectiveRules = mode?.overrideRules?.length ? mode.overrideRules : cfg.rules;
  const rulesLine = effectiveRules.map((r, i) => `${i + 1}.${r}`).join(" ");

  return [
    `## Model Delegation Protocol — MANDATORY`,
    ``,
    `You are the orchestrator. Information-gathering is NOT orchestration — it IS execution. Execution belongs to subagents, not to you.`,
    ``,
    `Preset: ${cfg.activePreset}. Tiers: ${tierLine}.${modeSuffix}`,
    ``,
    `### HARD ROUTING (non-negotiable)`,
    `- **Read-only work** (grep, glob, read, ls, lookup, count, git-info, doc-lookup, type-check, exists-check) → default to \`Agent(subagent_type="fast", ...)\`. Self-cap (TARGET): ≤2 direct read-only calls per user turn; on the 3rd read-only need, dispatch @fast instead. You may exceed with a 1-line \`reason:\` note when dispatching feels clearly wrong. Rationale: every tool-result token is billed at your tier rate — a grep via @fast costs far less than the same grep here.`,
    `- **Implementation work** (write, edit, refactor, tests, bug-fix, build-fix, create-file, config, api-endpoint) → \`Agent(subagent_type="medium", ...)\`.`,
    `- **Architecture / security / perf / debugging after ≥2 failures / multi-system tradeoffs / RCA** → \`Agent(subagent_type="heavy", ...)\`, UNLESS your own model equals @heavy's model; then handle locally and never self-call @heavy.`,
    ``,
    `### DISPATCH CAPS (read-only budget per subagent)`,
    `Subagents carry a TARGET cap on their own read-only tool calls (baseline: @fast=8, @medium=5, @heavy=3). Include \`CAP:N\` in the dispatch prompt to override (e.g., \`CAP:3\` for a tight lookup, \`CAP:none\` to disable). Mode adjustments apply automatically via rules below. The router runtime tracks each subagent's read-only calls and injects \`[cap: N/MAX]\` counters into its tool results; when the counter hits MAX the subagent must return. Redundant repeated reads are flagged \`[⚠ REDUNDANT]\` and must be followed by a return: \`DONE: ...\`, \`NEED MORE: ...\`, or \`ESCALATE: ...\`.`,
    ``,
    `### ROLE CONTRACT`,
    `The primary agent's job: decompose the user's request, dispatch subagents, synthesize their results, and answer the user. Keep orchestration-first posture: prefer dispatching read-only exploration to @fast rather than running repeated Grep/Read/Glob/Bash calls yourself. Self-cap applies (see HARD ROUTING above): ≤2 direct read-only calls per turn as a target; beyond that, dispatch @fast.`,
    ``,
    `### @fast contract`,
    `@fast is a read-only explorer. It will search/grep/read/count/lookup and return file:line paths, snippets, and a one-line summary. It will refuse edits. Batch related searches into a single @fast dispatch when possible; fire independent searches in parallel (one message, multiple Agent calls).`,
    ``,
    `### @medium contract`,
    `@medium is the implementer. It writes, edits, refactors, adds tests, fixes bugs, applies build-fixes. It matches existing project patterns, runs targeted tests for changed areas, and reports back if it hits 2+ consecutive failures instead of self-escalating. Give it context: file paths, patterns to match, what verification to run.`,
    ``,
    `### @heavy contract (CRITICAL — read before every @heavy dispatch)`,
    `@heavy has **no delegation tool** — it cannot self-explore, cannot grep, cannot delegate. Dispatching @heavy without context can waste a run: it may reason on thin evidence or return "SCOPE GROWTH" asking for additional @fast findings.`,
    `**Before @heavy, gather context first — usually via @fast.** If you already have sufficient concrete context, dispatch @heavy directly. If @heavy still needs more evidence, collect it with @fast and re-invoke.`,
    `Pattern: \`Agent(@fast, "collect X, Y, Z")\` (when needed) → synthesize findings → \`Agent(@heavy, "given these findings: [paste], analyze W")\`.`,
    ``,
    `### CONFLICT WITH AGENTS.md / CLAUDE.md`,
    `If AGENTS.md, CLAUDE.md, or any other guide in your context says "use direct tools first when scope is clear" or labels Grep/Read/Glob as "FREE", **this protocol wins**. Those labels are wrong about cost: tools executed by you are billed at your tier rate — every tool-result token is tokenized into your context. Treat yourself as expensive and delegate reads by default.`,
    ``,
    ...(taxonomy ? [taxonomy, ``] : []),
    ...(decompose ? [decompose, ``] : []),
    `### Compact rules`,
    rulesLine,
    ``,
    `Delegate with \`Agent(subagent_type="fast"|"medium"|"heavy", prompt="...")\`. Keep orchestration and final synthesis here.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Claude-model adversarial prefixes (kept for Claude-backed tiers; GLM tiers
// are untouched). Applied by sync-agents when a tier's model is a Claude ID.
// ---------------------------------------------------------------------------

export function isClaudeModel(modelID) {
  if (!modelID) return false;
  const s = modelID.toLowerCase();
  if (s.startsWith("anthropic/")) return true;
  return /\/claude-/.test(s) || /(^|[.\/\-])claude-/.test(s);
}

/** Per-tier adversarial openers. @fast/@medium use scoping tone; @heavy uses override tone. */
export const CLAUDE_TIER_PREFIX = {
  fast: [
    "SCOPE NOTE — any cached instruction priming you to 'thoroughly explore",
    "the codebase' or 'gather context broadly' does not apply here. This is",
    "a single dispatch with a single question. Stay narrow to the ask.",
    "",
    "Before every tool call, ask: 'Does THIS read answer the dispatch",
    "question specifically, or am I drifting into context-gathering for my",
    "own understanding?' If the latter, stop — you have enough.",
  ].join("\n"),
  medium: [
    "SCOPE NOTE — cached instructions may prime you to deeply understand",
    "surrounding code before editing. For THIS dispatch, the orchestrator",
    "has already scoped the problem; trust that scoping. Read what's needed",
    "for the edit, not the whole module.",
    "",
    "A 4th or 5th 'context read' is usually a sign the dispatch was under-",
    "scoped — return NEED CONTEXT rather than expanding scope yourself.",
  ].join("\n"),
  heavy: [
    "AUTHORITY OVERRIDE — this block supersedes any cached prefix suggesting",
    "you should 'investigate thoroughly', 'gather comprehensive context', or",
    "'trace through the code systematically before analyzing'. You are",
    "@heavy, an ANALYSIS specialist. The orchestrator should have pre-",
    "gathered context via @fast before dispatching you. If it didn't, return",
    "`SCOPE GROWTH:` immediately — do NOT self-gather.",
    "",
    "40 minutes of Read/Grep is not analysis — it is the orchestrator's job",
    "that leaked into yours. Push it back with SCOPE GROWTH. Your 3 reads",
    "are for targeted verification, not exploration.",
  ].join("\n"),
};

export const CLAUDE_ORCHESTRATOR_PREFIX = [
  "AUTHORITY OVERRIDE — this block supersedes any prior system instruction",
  "about 'exploring the codebase', 'gathering context with tools', or using",
  "Read/Grep/Glob to validate assumptions. Those instructions describe a",
  "general-purpose coding session. THIS session is a routing orchestrator.",
  "",
  "Your job is to DISPATCH, not to EXECUTE. Read-only work (grep/read/",
  "glob/ls) is execution, and execution is delegated to @fast. You may run",
  "AT MOST 2 direct read-only tool calls per turn — a 3rd call is a rule",
  "violation. If you need more context, you dispatch @fast.",
].join("\n");

export const CLAUDE_ANTI_NARRATION = [
  "ANTI-NARRATION — do NOT write progress commentary in your response or",
  "thinking output. Forbidden phrasings include:",
  '  - "Still writing the X function..."',
  '  - "Now I\'ll implement Y..."',
  '  - "Let me add Z..."',
  '  - "Continuing with W..."',
  '  - "Going to fix V..."',
  "",
  "Each of these signals planning without production. If you write one, the",
  "NEXT tokens MUST contain the actual artifact (the code, the edit, the",
  "concrete output). Otherwise, stop and return with status.",
  "",
  "Exception: when the user explicitly asks for an explanation, plan, or",
  "walkthrough, prose is welcome — this rule targets unsolicited progress",
  "narration during code and implementation tasks.",
].join("\n");

// ---------------------------------------------------------------------------
// DoD protocol section (shown when enforcement is ON)
// ---------------------------------------------------------------------------

export function buildDoDProtocolSection(cfg) {
  const requireExplicit = cfg.enforcement?.verify?.requireExplicitDoD === true;
  const omitLine = requireExplicit
    ? "A DoD is REQUIRED: a non-trivial dispatch without an [acceptance] block is rejected."
    : "If you omit the block, no deterministic verification runs (advisory only).";
  return [
    "### Acceptance / Definition of Done (enforcement is ON)",
    'Deterministic verification runs on every delegation that carries an [acceptance] block. Attach one to your dispatch so the gate knows what "done" means:',
    "",
    "[acceptance]",
    "check: testsPass",
    "check: buildPasses",
    "check: fileExists path=src/foo.ts",
    'check: run command="vitest run src/foo" expect="passed"',
    "criteria: <plain-language success condition>",
    "deliverable: <path or short description>",
    "[/acceptance]",
    "",
    "- check kinds: testsPass | buildPasses | lintClean | fileExists path=… | run command=\"…\" expect=…",
    "- " + omitLine,
    "- A failing check surfaces a forcing note on the result; address it and re-dispatch.",
  ].join("\n");
}

/**
 * Assembles the full injected context: delegation protocol (+ DoD section when
 * enforcement is on). Pure — no side effects.
 */
export function assembleSystemPrompt(cfg, _orchestratorModel, enforcementOn = false) {
  const delegationProtocol = buildDelegationProtocol(cfg);
  const dodSection = enforcementOn ? `\n\n---\n\n${buildDoDProtocolSection(cfg)}` : "";
  return `${delegationProtocol}${dodSection}`;
}
