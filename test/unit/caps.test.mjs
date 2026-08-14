import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TIER_CAPS,
  READ_ONLY_TOOLS,
  ORCHESTRATOR_TURN_CAP,
  parseCapDirective,
  buildCapBanner,
  classifyTrivial,
  initSubagentState,
  loadCapState,
  precheckRead,
  recordReadCall,
  resetTurnReads,
  bumpTurnReads,
  clearSession,
  gcCapFiles,
} from "../../hooks/scripts/lib/caps.mjs";

// The cap store lives under homedir(); sandbox $HOME per test so we never
// touch real state. (node's homedir() reads $HOME on Linux)
const realHome = homedir();
let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "router-caps-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

const cfg = {
  presets: { zai: { fast: {}, medium: {}, heavy: {} } },
  tierCaps: { fast: 8, medium: 5, heavy: 3 },
  taskPatterns: {
    fast: ["search", "grep", "read"],
    medium: ["impl-feature", "refactor"],
    heavy: ["arch-design"],
  },
};

describe("constants", () => {
  it("keeps the opencode baselines", () => {
    expect(DEFAULT_TIER_CAPS).toEqual({ fast: 8, medium: 5, heavy: 3 });
    expect(ORCHESTRATOR_TURN_CAP).toBe(2);
  });
});

describe("parseCapDirective", () => {
  it("parses CAP:N, CAP:none, and is case/space tolerant", () => {
    expect(parseCapDirective("do X CAP:3 thanks")).toBe(3);
    expect(parseCapDirective("CAP: none ok")).toBe("none");
    expect(parseCapDirective("cap:12")).toBe(12);
  });

  it("rejects zero / missing directives", () => {
    expect(parseCapDirective("CAP:0")).toBeNull();
    expect(parseCapDirective("no directive")).toBeNull();
    expect(parseCapDirective(undefined)).toBeNull();
  });
});

describe("buildCapBanner", () => {
  it("renders the plain counter", () => {
    const s = { cap: 5, calls: 2 };
    expect(buildCapBanner(s, false, undefined, "grep")).toBe("[cap: 2/5]");
  });

  it("warns when ≤2 calls remain", () => {
    const s = { cap: 5, calls: 3 };
    expect(buildCapBanner(s, false, undefined, "grep")).toContain(
      "[⚠ CAP WARNING: 2 read-only call(s) remaining before forced return]",
    );
  });

  it("commands a return at cap", () => {
    const s = { cap: 5, calls: 5 };
    const b = buildCapBanner(s, false, undefined, "grep");
    expect(b).toContain("[cap: 5/5]");
    expect(b).toContain("[⚠ CAP REACHED (5/5)");
    expect(b).toContain("DONE:");
  });

  it("flags redundancy with the original call number", () => {
    const s = { cap: 8, calls: 4 };
    const b = buildCapBanner(s, true, 1, "read");
    expect(b).toContain("[⚠ REDUNDANT: this is the same read you ran at call #1");
  });

  it("uses ∞ for cap:none and never warns about the numeric cap", () => {
    const s = { cap: "none", calls: 99 };
    const b = buildCapBanner(s, false, undefined, "read");
    expect(b).toBe("[cap: 99/∞]");
  });
});

describe("classifyTrivial", () => {
  it("only fast-tier dispatches with a fast keyword are trivial", () => {
    expect(classifyTrivial("grep for foo", "fast", cfg)).toBe(true);
    expect(classifyTrivial("grep for foo", "medium", cfg)).toBe(false);
    expect(classifyTrivial("refactor the module", "fast", cfg)).toBe(false); // medium keyword disqualifies
    expect(classifyTrivial("", "fast", cfg)).toBe(false);
  });
});

describe("disk-backed cap state", () => {
  it("initialises from tierCaps baseline and falls back to the hardcoded default", () => {
    const s = initSubagentState("s1", "fast", cfg);
    expect(s).toMatchObject({ tier: "fast", cap: 8, calls: 0 });
    const s2 = initSubagentState("s2", "unknown-tier", cfg);
    expect(s2.cap).toBe(5);
  });

  it("precheckRead lazily initialises and detects repeats without recording", () => {
    initSubagentState("s3", "heavy", cfg); // cap 3
    const tool = "Grep";
    const args = { pattern: "x" };
    recordReadCall("s3", "heavy", tool, args, cfg);
    recordReadCall("s3", "heavy", tool, args, cfg);
    const pre = precheckRead("s3", "heavy", tool, args, cfg);
    expect(pre.isRedundant).toBe(true); // same grep pattern → repeat
    expect(pre.previousCall).toBe(1);
    const state = loadCapState("s3");
    expect(state.calls).toBe(2); // precheck must not increment
  });

  it("recordReadCall increments, dedupes fingerprints, and persists", () => {
    initSubagentState("s4", "fast", cfg);
    const r1 = recordReadCall("s4", "fast", "Read", { file_path: "/a" }, cfg);
    expect(r1.state.calls).toBe(1);
    expect(r1.banner).toBe("[cap: 1/8]");
    const r2 = recordReadCall("s4", "fast", "Read", { file_path: "/a" }, cfg);
    expect(r2.isRedundant).toBe(true);
    expect(r2.banner).toContain("⚠ REDUNDANT");
    expect(r2.state.calls).toBe(2);
    const r3 = recordReadCall("s4", "fast", "Read", { file_path: "/b" }, cfg);
    expect(r3.isRedundant).toBe(false);
    // reload from disk to prove persistence
    expect(loadCapState("s4").calls).toBe(3);
  });

  it("ignores non-read-only tools", () => {
    initSubagentState("s5", "fast", cfg);
    expect(recordReadCall("s5", "fast", "Write", { file_path: "/a" }, cfg)).toBeNull();
    expect(precheckRead("s5", "fast", "Bash", { command: "ls" }, cfg)).toBeNull();
  });

  it("clearSession removes both cap and turn files", () => {
    initSubagentState("s6", "fast", cfg);
    resetTurnReads("s6");
    clearSession("s6");
    expect(loadCapState("s6")).toBeNull();
  });
});

describe("orchestrator turn counters", () => {
  it("resets and bumps", () => {
    resetTurnReads("orch1");
    expect(bumpTurnReads("orch1")).toBe(1);
    expect(bumpTurnReads("orch1")).toBe(2);
    resetTurnReads("orch1");
    expect(bumpTurnReads("orch1")).toBe(1);
  });
});

describe("gcCapFiles", () => {
  it("removes only stale files", () => {
    const dir = join(tmpHome, ".zcode", "model-router", "caps");
    mkdirSync(dir, { recursive: true });
    const fresh = join(dir, "fresh.json");
    writeFileSync(fresh, "{}");
    const stale = join(dir, "stale.json");
    writeFileSync(stale, "{}");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const removed = gcCapFiles(24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});

describe("READ_ONLY_TOOLS", () => {
  it("matches lowercase zcode tool names", () => {
    expect(READ_ONLY_TOOLS.has("read")).toBe(true);
    expect(READ_ONLY_TOOLS.has("ls")).toBe(true);
    expect(READ_ONLY_TOOLS.has("write")).toBe(false);
  });
});
