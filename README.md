# zcode-model-router

> **Use the cheapest model that can do the job. Automatically.**

A zcode plugin that routes every coding task to the right-priced tier — automatically, on every message — via smart subagent delegation.

Adapted from [opencode-model-router](https://github.com/marco-jardim/opencode-model-router) v1.3 to zcode's Claude Code-compatible plugin architecture: agents, hooks, and commands instead of the OpenCode plugin API.

## Why it's different

Most AI coding tools run one model for everything. You pay flagship-model prices to run `grep`. zcode-model-router changes that:

**Run a mid-tier orchestrator, delegate everything else.**
The orchestrator runs on *every* message. Put a mid-priced model there. The router injects a dense delegation protocol that teaches it to dispatch read-only work to a cheap subagent and reserve the heavy tier for architecture/debug — at a fraction of the cost.

**Injected delegation protocol (~1 page, every message).**
A `UserPromptSubmit` hook injects the protocol as context on every user message: tier models + cost ratios, a keyword task taxonomy, hard routing rules, dispatch caps, and the multi-phase decomposition pattern (explore cheap → execute smart).

**Tier subagents with per-tier models.**
Three subagents ship out of the box (`fast` / `medium` / `heavy`), each a static agent file with its own `model` and `thoughtLevel`. Your default Z.ai stack:

| Tier | Model | Reasoning | Cost ratio | Read-only cap |
|------|-------|-----------|-----------:|--------------:|
| `@fast` | GLM-4.7-Flash | — | 1x | 8 |
| `@medium` | GLM-5.3 | high | 5x | 5 |
| `@heavy` | GLM-5.3 | max | 20x | 3 |

> GLM-4.7-Flash not available on your plan? Switch to the `zai-turbo` preset (`GLM-4.7` / `GLM-5.2` / `GLM-5.3 max`) with `/preset zai-turbo` + `npm run sync-agents`.

**Runtime cap enforcement (not just prompt rules).**
Prompt-only caps get ignored. So the router *observes* every read-only tool call a subagent makes (PostToolUse hook) and injects a live counter into its context:

```
[cap: 4/8]
[⚠ CAP WARNING: 1 read-only call(s) remaining before forced return]
```

Redundant repeats get flagged (`[⚠ REDUNDANT: this is the same grep you ran at call #1. STOP…]`), and in `enforced` mode the PreToolUse guard **hard-denies** the call outright. Counters live on disk keyed by subagent session, so they survive across hook processes.

**Deterministic acceptance checks.**
Delegations that carry an `[acceptance]` block are verified after the subagent returns: `testsPass`, `buildPasses`, `lintClean`, `fileExists`, `run command="…" expect="…"`, `schemaMatch`. Failures surface a forcing note naming the next tier on the escalation ladder.

**Four routing modes.**
`/budget normal|budget|quality|deep` — balanced, aggressive savings (defaults cheap), quality-first, or heavy-first for long architecture/debug runs. Mode persists across restarts and re-shapes the injected protocol immediately.

**Plan annotation.**
`/annotate-plan [path]` tags each plan step with `[tier:fast|medium|heavy]` (+ `[acceptance]` blocks), removing routing ambiguity from multi-step work.

## How it works

```
UserPromptSubmit ──► inject delegation protocol (every message)
                      │
Orchestrator decides ─┬─ read-only work ───► Agent(subagent_type="fast")
                      ├─ implementation ───► Agent(subagent_type="medium")
                      └─ arch/debug/sec ───► Agent(subagent_type="heavy")
                      │
PreToolUse  (Read|Grep|Glob|LS)  guard: deny at cap / on repeat (enforced mode)
PostToolUse (Read|Grep|Glob|LS)  banner: [cap: N/MAX] / ⚠ REDUNDANT / ⚠ CAP REACHED
PostToolUse (Task|Agent)         deterministic DoD verification + forcing note
Stop                             narration detection (post-hoc banner)
```

- Subagent sessions are detected via the hook payload's `agent_type`; cap state lives in `~/.zcode/model-router/caps/<session_id>.json`.
- Orchestrator self-cap: ≤2 direct read-only calls per turn (advisory nudge past that; never blocked).
- State (`preset` / `mode` / `enforcement` / `bypass`) persists in `~/.zcode/model-router/state.json`.

### Enforcement modes

| Mode | Behavior |
|------|----------|
| `off` | All router hooks no-op — byte-for-byte unchanged sessions |
| `advisory` *(default)* | Banners + forcing notes, nothing blocked |
| `enforced` | Guard hard-denies subagent read-only calls that breach cap/redundancy policy |

Switch at runtime: `/router enforce <off|advisory|enforced>`, or force per-session with `MODEL_ROUTER_ENFORCE=0|1`.

### Known limitations vs the opencode original

- **No grader dispatch / runtime escalation loop.** zcode exposes no programmatic session API, so Layer-2 verification is deterministic-checks-only and the escalation ladder is advisory (the forcing note names the next tier; the orchestrator re-dispatches).
- **No cross-provider fallback chains.** Models are static per agent file; `/preset` + `npm run sync-agents` regenerates them.
- **Per-dispatch `CAP:N` overrides are prompt-level only.** Hook payloads don't link child sessions to dispatch prompts, so the runtime enforces per-tier baselines from `tierCaps`; `CAP:N`/`CAP:none` in a dispatch prompt still steer the subagent itself.

## Installation

zcode loads plugins from marketplaces, and a local directory works as one:

1. **Add the marketplace**: zcode → Settings → Plugin Management → Discover → `+` → add this repository's local path.
2. **Install** the `zcode-model-router` plugin from it.
3. **Verify**: agent files are committed, but after editing `tiers.json` run:

```bash
npm install        # dev only, for the test suite
npm run sync-agents
npm test
```

Restart your zcode session (or open a new one) so the plugin's agents, hooks, and commands load.

## Configuration

Everything lives in `tiers.json` at the plugin root.

### Presets

`presets.<name>.{fast,medium,heavy}` each carry `model`, optional `thoughtLevel` (reasoning variant — must be one of the model's supported levels, e.g. `high`/`max` for GLM-5.3), `costRatio`, `maxTurns`, `tools`, `color`, `description`, `whenToUse`. Switch with `/preset <name>`, then run `npm run sync-agents` and restart.

### Read-only caps

```json
{ "tierCaps": { "fast": 8, "medium": 5, "heavy": 3 } }
```

Enforced at runtime via the guard/banner hooks; orchestrator self-cap is 2 direct reads per turn.

### Task taxonomy / rules / modes

`taskPatterns` (keyword routing guide), `rules` (compact numbered rules), `modes` (normal/budget/quality/deep with optional `overrideRules` that replace the global ruleset in that mode) — all injected into the delegation protocol. `tierPrompts` holds the subagent system prompts rendered into `agents/*.md` by `sync-agents`.

### Verification defaults

```json
{ "verifyDefaults": { "testCommand": "npm test", "buildCommand": "npm run build", "lintCommand": "npm run lint" } }
```

Used by `testsPass`/`buildPasses`/`lintClean` checks that don't carry an explicit `command=`.

## Commands

| Command | Description |
|---------|-------------|
| `/tiers` | Show active tiers, models, caps, and rules |
| `/preset [name]` | List or switch presets |
| `/budget [mode]` | List or switch routing mode (`normal`, `budget`, `quality`, `deep`) |
| `/router [enforce <mode>]` | Status or enforcement level |
| `/bypass [on\|off]` | Toggle the router off entirely |
| `/annotate-plan [path]` | Tag a plan with `[tier:X]` + `[acceptance]` blocks |

## Cost intuition

Same math as the opencode original, mapped to the GLM stack: a session where ~60% of work is exploration runs that exploration at 1x instead of your orchestrator's rate, implementation lands on the mid tier, and only genuine architecture/debug burns the 20x tier. Composite tasks ("find how auth works, then refactor it") split into `@fast` explore + `@medium` execute — the single biggest saving on everyday work.

## Development

```bash
npm test          # unit (lib modules) + contract (spawn hook scripts, assert strict stdout JSON)
npm run sync-agents
```

Layout:

```
.zcode-plugin/plugin.json    manifest
agents/*.md                  generated subagent definitions (fast/medium/heavy)
hooks/hooks.json             hook registrations (6 entries)
hooks/scripts/*.mjs          hook entry points + cli backend
hooks/scripts/lib/*.mjs      pure logic (protocol, caps, dod, deterministic, enforce, …)
commands/*.md                /tiers /preset /budget /bypass /router /annotate-plan
scripts/sync-agents.mjs      renders agents/ from tiers.json
test/unit, test/contract     vitest suites
```

## License

GPL-3.0
