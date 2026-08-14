import { describe, it, expect } from "vitest";
import {
  parseAcceptanceBlock,
  parseDoDFromDispatch,
  inferDoD,
  normalizeDoD,
  isCheckable,
  summarizeDispatch,
} from "../../hooks/scripts/lib/dod.mjs";
import { runDeterministic, isCommandAllowed, shapeMismatch, DEFAULT_ALLOWLIST, FORBIDDEN_SHELL } from "../../hooks/scripts/lib/deterministic.mjs";
import { buildForcingNote, nextTierAfter } from "../../hooks/scripts/lib/forcing.mjs";

describe("parseAcceptanceBlock", () => {
  const text = [
    "Implement the thing.",
    "[acceptance]",
    "check: testsPass",
    'check: run command="vitest run x" expect="passed"',
    "check: fileExists path=src/foo.ts",
    "check: bogusKind",
    "criteria: it works",
    "deliverable: src/foo.ts",
    "[/acceptance]",
  ].join("\n");

  const dod = parseAcceptanceBlock(text);

  it("extracts valid checks and skips unknown kinds", () => {
    expect(dod.checks.map((c) => c.kind)).toEqual(["testsPass", "run", "fileExists"]);
    expect(dod.checks[1]).toMatchObject({ kind: "run", command: "vitest run x", expect: "passed" });
    expect(dod.checks[2]).toMatchObject({ kind: "fileExists", path: "src/foo.ts" });
  });

  it("captures criteria + deliverable and marks deterministic", () => {
    expect(dod.kind).toBe("deterministic");
    expect(dod.criteria).toEqual(["it works"]);
    expect(dod.deliverable).toBe("src/foo.ts");
    expect(dod.source).toBe("explicit");
  });

  it("returns null without open or close tags", () => {
    expect(parseAcceptanceBlock("no tags here")).toBeNull();
    expect(parseAcceptanceBlock("[acceptance]\ncheck: testsPass")).toBeNull();
  });

  it("accepts [dod] as an alias", () => {
    const alt = parseAcceptanceBlock("[dod]\ncheck: lintClean\n[/dod]");
    expect(alt.checks[0].kind).toBe("lintClean");
  });

  it("criteria-only blocks classify as checker", () => {
    const c = parseAcceptanceBlock("[acceptance]\ncriteria: looks right\n[/acceptance]");
    expect(c.kind).toBe("checker");
    expect(c.checks).toHaveLength(0);
  });
});

describe("inferDoD", () => {
  const hints = { testCommand: "npm test", buildCommand: "npm run build", lintCommand: "npm run lint" };

  it("bugfix inference attaches build+test checks", () => {
    const d = inferDoD("fix the broken login flow", "", hints);
    expect(d.checks.map((c) => c.kind)).toEqual(["buildPasses", "testsPass"]);
    expect(d.source).toBe("inferred");
  });

  it("falls back to a criteria-only DoD when no hints apply", () => {
    const d = inferDoD("research the auth design", "", {});
    expect(d.kind).toBe("checker");
    expect(d.criteria.length).toBe(1);
  });
});

describe("normalizeDoD / isCheckable / summarizeDispatch", () => {
  it("empty DoD normalizes to kind none", () => {
    const d = normalizeDoD({ checks: [], criteria: [], deliverable: "  ", source: "none" });
    expect(d.kind).toBe("none");
    expect(d.deliverable).toBeNull();
    expect(isCheckable(d)).toBe(false);
  });

  it("summarizeDispatch takes the first non-empty line, capped at 120", () => {
    expect(summarizeDispatch("\n\n  hello   world  \nrest")).toBe("hello world");
    expect(summarizeDispatch("x".repeat(200)).length).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// deterministic
// ---------------------------------------------------------------------------

const fsStub = (files) => ({
  async fileExists(p) {
    return Object.prototype.hasOwnProperty.call(files, p);
  },
  async readFile(p) {
    if (!(p in files)) throw new Error("ENOENT: " + p);
    return files[p];
  },
});

describe("isCommandAllowed", () => {
  it("allowlists bare tool basenames", () => {
    expect(isCommandAllowed("vitest run", DEFAULT_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed("/usr/bin/npm test", DEFAULT_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed("curl http://x", DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("rejects shell metacharacters", () => {
    expect(isCommandAllowed("npm test && curl x", DEFAULT_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed("npm test | sh", DEFAULT_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed("npm test > out", DEFAULT_ALLOWLIST)).toBe(false);
    expect(FORBIDDEN_SHELL.test("npm $(x)")).toBe(true);
  });

  it("rejects interpreter inline-eval flags", () => {
    expect(isCommandAllowed("node -e code()", DEFAULT_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed("node script.js", DEFAULT_ALLOWLIST)).toBe(true);
  });
});

describe("shapeMismatch", () => {
  it("passes on matching shapes, reports missing keys and type drift", () => {
    expect(shapeMismatch({ a: 1, b: [] }, { a: 2, b: [1], extra: true })).toBeNull();
    expect(shapeMismatch({ a: 1 }, {})).toBe("a: missing");
    expect(shapeMismatch({ a: 1 }, { a: "s" })).toBe("a.: expected number, got string");
    expect(shapeMismatch([1], "nope")).toBe("<root>: expected array");
  });
});

describe("runDeterministic", () => {
  it("skips when there are no checks", async () => {
    const v = await runDeterministic({ checks: [] }, {});
    expect(v.skipped).toBe(true);
    expect(v.pass).toBe(false);
  });

  it("fileExists pass/fail with evidence", async () => {
    const deps = { fs: fsStub({ "src/a.ts": "x" }), exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
    const ok = await runDeterministic({ checks: [{ kind: "fileExists", path: "src/a.ts" }] }, deps);
    expect(ok.pass).toBe(true);
    expect(ok.evidence).toContain("exists: src/a.ts");
    const bad = await runDeterministic({ checks: [{ kind: "fileExists", path: "src/missing.ts" }] }, deps);
    expect(bad.pass).toBe(false);
    expect(bad.reasons[0]).toContain("file not found");
  });

  it("run check honours expect substring and exit code", async () => {
    const deps = {
      fs: fsStub({}),
      exec: async (cmd) => ({ code: 0, stdout: `all ${cmd} passed`, stderr: "" }),
    };
    const ok = await runDeterministic({ checks: [{ kind: "run", command: "vitest run", expect: "passed" }] }, deps);
    expect(ok.pass).toBe(true);
    const fail = await runDeterministic({ checks: [{ kind: "run", command: "vitest run", expect: "nope" }] }, deps);
    expect(fail.pass).toBe(false);
    expect(fail.reasons[0]).toContain("expected substring not found");
  });

  it("rejects non-allowlisted commands fail-closed", async () => {
    const deps = { fs: fsStub({}), exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
    const v = await runDeterministic({ checks: [{ kind: "run", command: "rm -rf /" }] }, deps);
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain("not allowlisted");
  });

  it("testsPass uses the injected default command", async () => {
    let seen;
    const deps = {
      fs: fsStub({}),
      defaults: { testCommand: "vitest run" },
      exec: async (cmd) => {
        seen = cmd;
        return { code: 1, stdout: "", stderr: "boom" };
      },
    };
    const v = await runDeterministic({ checks: [{ kind: "testsPass" }] }, deps);
    expect(seen).toBe("vitest run");
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain("command exited 1");
  });

  it("schemaMatch validates shape", async () => {
    const deps = {
      fs: fsStub({ "out.json": '{"a": 1}', "schema.json": '{"a": 0, "b": []}' }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const v = await runDeterministic(
      { checks: [{ kind: "schemaMatch", path: "out.json", schema: "schema.json" }] },
      deps,
    );
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain("b: missing");
  });
});

// ---------------------------------------------------------------------------
// forcing
// ---------------------------------------------------------------------------

describe("buildForcingNote", () => {
  it("lists reasons and the escalate target", () => {
    const note = buildForcingNote(["file not found: x", "command exited 1"], {
      producerTier: "fast",
      nextTier: "medium",
    });
    expect(note).toContain("[router ⚠ NOT ACCEPTED]");
    expect(note).toContain("- file not found: x");
    expect(note).toContain('Agent(subagent_type="medium")');
    expect(note).toContain("escalated from fast");
  });

  it("falls back to a generic NEXT without an escalation target", () => {
    const note = buildForcingNote([]);
    expect(note).toContain("- (no reasons provided)");
    expect(note).toContain("re-run the delegation");
  });

  it("scrubs secrets out of reasons", () => {
    const note = buildForcingNote(['cmd failed api_key="abcdef123456"']);
    expect(note).not.toContain("abcdef123456");
    expect(note).toContain("[REDACTED]");
  });
});

describe("nextTierAfter", () => {
  it("walks the ladder and stops at the top", () => {
    const ladder = ["fast", "medium", "heavy"];
    expect(nextTierAfter(ladder, "fast")).toBe("medium");
    expect(nextTierAfter(ladder, "medium")).toBe("heavy");
    expect(nextTierAfter(ladder, "heavy")).toBeNull();
    expect(nextTierAfter(ladder, "unknown")).toBeNull();
  });
});
