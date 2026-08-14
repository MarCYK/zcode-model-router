import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = join(PLUGIN_ROOT, "hooks", "scripts");

const realHome = homedir();
let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "router-contract-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Run a hook script with a stdin payload; returns the spawnSync result. */
function runHook(script, payload, extraEnv = {}) {
  return spawnSync("node", [join(SCRIPTS, script)], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      ...extraEnv,
    },
    timeout: 20000,
  });
}

function jsonOut(res) {
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout);
}

function statePath() {
  return join(tmpHome, ".zcode", "model-router", "state.json");
}

function writeRouterState(patch) {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const cur = JSON.parse(readFileSync(p, "utf-8"));
  writeFileSync(p, JSON.stringify({ ...cur, ...patch }));
}

function runCli(...args) {
  return spawnSync("node", [join(SCRIPTS, "cli.mjs"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    timeout: 20000,
  });
}

describe("protocol-inject (UserPromptSubmit)", () => {
  const payload = { hook_event_name: "UserPromptSubmit", session_id: "orch-1", agent_type: "primary", prompt: "go" };

  it("emits the delegation protocol as additionalContext", () => {
    const out = jsonOut(runHook("protocol-inject.mjs", payload));
    expect(out.hookEventName).toBe("UserPromptSubmit");
    expect(out.additionalContext).toContain("Model Delegation Protocol");
    expect(out.additionalContext).toContain('Agent(subagent_type="fast"');
    expect(out.additionalContext).toContain("@fast=GLM-4.7(1x)");
  });

  it("resets the orchestrator turn counter", () => {
    runHook("protocol-inject.mjs", payload);
    const turnFile = join(tmpHome, ".zcode", "model-router", "caps", "turn-orch-1.json");
    expect(JSON.parse(readFileSync(turnFile, "utf-8"))).toMatchObject({ reads: 0 });
  });

  it("injects nothing for subagent sessions", () => {
    const res = runHook("protocol-inject.mjs", { ...payload, agent_type: "fast" });
    expect(res.stdout).toBe("");
  });

  it("injects nothing when bypassed", () => {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ bypass: true }));
    const res = runHook("protocol-inject.mjs", payload);
    expect(res.stdout).toBe("");
  });
});

describe("subagent-guard (PreToolUse Read|Grep|Glob|LS)", () => {
  const base = { hook_event_name: "PreToolUse", session_id: "sub-1", agent_type: "fast", tool_name: "Grep", tool_input: { pattern: "foo" } };

  it("allows a fresh in-cap read silently", () => {
    const res = runHook("subagent-guard.mjs", base);
    expect(res.stdout).toBe("");
  });

  it("advises (never denies) in advisory mode at cap", () => {
    // cap fast=8: pre-record 8 reads
    for (let i = 0; i < 8; i++) {
      runHook("cap-banner.mjs", { ...base, tool_input: { pattern: `p${i}` } });
    }
    const out = jsonOut(runHook("subagent-guard.mjs", { ...base, tool_input: { pattern: "new" } }));
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toContain("CAP REACHED");
  });

  it("denies in enforced mode at cap (permissionDecision deny)", () => {
    for (let i = 0; i < 8; i++) {
      runHook("cap-banner.mjs", { ...base, tool_input: { pattern: `p${i}` } });
    }
    const out = jsonOut(
      runHook("subagent-guard.mjs", { ...base, tool_input: { pattern: "new" } }, { MODEL_ROUTER_ENFORCE: "1" }),
    );
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("CAP REACHED");
    expect(out.permissionDecisionReason).toContain("DONE:");
  });

  it("denies redundant repeats in enforced mode", () => {
    runHook("cap-banner.mjs", base); // record grep pattern foo once
    const out = jsonOut(
      runHook("subagent-guard.mjs", base, { MODEL_ROUTER_ENFORCE: "1" }),
    );
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("REDUNDANT");
  });

  it("no-ops when enforcement is off via env", () => {
    runHook("cap-banner.mjs", base);
    const res = runHook("subagent-guard.mjs", base, { MODEL_ROUTER_ENFORCE: "0" });
    expect(res.stdout).toBe("");
  });

  it("nudges the orchestrator past the self-cap but never denies", () => {
    const orch = { hook_event_name: "PreToolUse", session_id: "orch-9", agent_type: "primary", tool_name: "Read", tool_input: { file_path: "/x" } };
    const r1 = runHook("subagent-guard.mjs", orch); // read 1
    expect(r1.stdout).toBe("");
    const r2 = runHook("subagent-guard.mjs", orch); // read 2
    expect(r2.stdout).toBe("");
    const out = jsonOut(runHook("subagent-guard.mjs", orch)); // read 3 → nudge
    expect(out.additionalContext).toContain("self-cap");
    expect(out.permissionDecision).toBeUndefined();
  });
});

describe("cap-banner (PostToolUse Read|Grep|Glob|LS)", () => {
  it("counts up and warns near the cap", () => {
    const p = (i) => ({ hook_event_name: "PostToolUse", session_id: "sub-2", agent_type: "heavy", tool_name: "Grep", tool_input: { pattern: `x${i}` } });
    expect(jsonOut(runHook("cap-banner.mjs", p(1))).additionalContext).toContain("[cap: 1/3]");
    expect(jsonOut(runHook("cap-banner.mjs", p(2))).additionalContext).toContain("CAP WARNING: 1 read-only call(s) remaining");
    const last = jsonOut(runHook("cap-banner.mjs", p(3)));
    expect(last.additionalContext).toContain("[cap: 3/3]");
    expect(last.additionalContext).toContain("CAP REACHED (3/3)");
  });

  it("flags redundant repeats", () => {
    const p = { hook_event_name: "PostToolUse", session_id: "sub-3", agent_type: "fast", tool_name: "Read", tool_input: { file_path: "/a" } };
    runHook("cap-banner.mjs", p);
    const out = jsonOut(runHook("cap-banner.mjs", p));
    expect(out.additionalContext).toContain("⚠ REDUNDANT");
    expect(out.additionalContext).toContain("call #1");
  });

  it("emits nothing for orchestrator sessions", () => {
    const res = runHook("cap-banner.mjs", { hook_event_name: "PostToolUse", session_id: "orch-2", agent_type: "primary", tool_name: "Read", tool_input: { file_path: "/a" } });
    expect(res.stdout).toBe("");
  });
});

describe("dispatch-verify (PostToolUse Task|Agent)", () => {
  const cwd = process.cwd();

  it("verifies a failing fileExists check and injects a forcing note with the next tier", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "orch-3",
      agent_type: "primary",
      cwd,
      tool_name: "Agent",
      tool_input: {
        subagent_type: "fast",
        prompt: "create the file\n[acceptance]\ncheck: fileExists path=definitely/missing/file.xyz\ndeliverable: definitely/missing/file.xyz\n[/acceptance]",
      },
      tool_response: { output: "DONE: created it" },
    };
    const out = jsonOut(runHook("dispatch-verify.mjs", payload));
    expect(out.hookEventName).toBe("PostToolUse");
    expect(out.additionalContext).toContain("[router ⚠ NOT ACCEPTED]");
    expect(out.additionalContext).toContain("file not found");
    expect(out.additionalContext).toContain('Agent(subagent_type="medium")');
  });

  it("passes a satisfied fileExists check silently", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "orch-4",
      agent_type: "primary",
      cwd,
      tool_name: "Agent",
      tool_input: {
        subagent_type: "medium",
        prompt: `[acceptance]\ncheck: fileExists path=${join(cwd, "tiers.json")}\n[/acceptance]`,
      },
      tool_response: { output: "DONE" },
    };
    const res = runHook("dispatch-verify.mjs", payload);
    expect(res.stdout).toBe("");
  });

  it("skips dispatches without an acceptance block", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "orch-5",
      agent_type: "primary",
      cwd,
      tool_name: "Agent",
      tool_input: { subagent_type: "fast", prompt: "just grep something" },
      tool_response: { output: "DONE" },
    };
    const res = runHook("dispatch-verify.mjs", payload);
    expect(res.stdout).toBe("");
  });

  it("no-ops when enforcement is off", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "orch-6",
      agent_type: "primary",
      cwd,
      tool_name: "Agent",
      tool_input: {
        subagent_type: "fast",
        prompt: "[acceptance]\ncheck: fileExists path=definitely/missing.xyz\n[/acceptance]",
      },
    };
    const res = runHook("dispatch-verify.mjs", payload, { MODEL_ROUTER_ENFORCE: "0" });
    expect(res.stdout).toBe("");
  });

  it("ignores non-delegation tools", () => {
    const res = runHook("dispatch-verify.mjs", {
      hook_event_name: "PostToolUse",
      session_id: "orch-7",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    expect(res.stdout).toBe("");
  });
});

describe("narration-scan (Stop)", () => {
  it("banners narration in the final message", () => {
    const out = jsonOut(
      runHook("narration-scan.mjs", {
        hook_event_name: "Stop",
        session_id: "s",
        last_assistant_message: "Still writing the auth function, almost there now.",
      }),
    );
    expect(out.hookEventName).toBe("Stop");
    expect(out.additionalContext).toContain("narration detected");
  });

  it("stays silent on clean messages", () => {
    const res = runHook("narration-scan.mjs", {
      hook_event_name: "Stop",
      session_id: "s",
      last_assistant_message: "Implementation complete: 3 files changed, tests pass.",
    });
    expect(res.stdout).toBe("");
  });
});

describe("cli state commands", () => {
  it("budget switches mode and persists; router enforce persists; bypass toggles", () => {
    const b = runCli("budget", "budget");
    expect(b.stdout).toContain("Routing mode switched to **budget**");

    const e = runCli("router", "enforce", "enforced");
    expect(e.stdout).toContain("Enforcement mode set to **enforced**");

    const by = runCli("bypass", "on");
    expect(by.stdout).toContain("Bypass: ON");

    const state = JSON.parse(readFileSync(statePath(), "utf-8"));
    expect(state).toMatchObject({ activeMode: "budget", enforcementMode: "enforced", bypass: true });

    // protocol injection now suppressed by bypass
    const res = runHook("protocol-inject.mjs", { hook_event_name: "UserPromptSubmit", session_id: "x", agent_type: "primary" });
    expect(res.stdout).toBe("");
  });

  it("preset switching persists a known preset and rejects unknown ones", () => {
    const ok = runCli("preset", "zai-turbo");
    expect(ok.stdout).toContain("Preset switched to **zai-turbo**");
    const bad = runCli("preset", "nope");
    expect(bad.stdout).toContain("Unknown preset");
  });
});

describe("session-start (SessionStart)", () => {
  it("exits clean with no output", () => {
    const capsDir = join(tmpHome, ".zcode", "model-router", "caps");
    mkdirSync(capsDir, { recursive: true });
    writeFileSync(join(capsDir, "stale.json"), "{}");
    const res = runHook("session-start.mjs", { hook_event_name: "SessionStart", source: "startup" });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });
});
