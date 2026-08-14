#!/usr/bin/env node
// hooks/scripts/dispatch-verify.mjs
// PostToolUse hook (matcher: Task|Agent) — Layer-2 deterministic acceptance.
//
// When an Agent/Task dispatch completes, parses an [acceptance] block from
// the dispatch prompt and runs its deterministic checks (testsPass /
// buildPasses / lintClean / fileExists / run / schemaMatch) against the
// payload cwd. On failure, injects an advisory forcing note naming the next
// tier on the escalation ladder. zcode has no programmatic session API, so
// there is no grader dispatch and no automatic retry — the note steers the
// orchestrator instead.

import { readHookInput, emitHookOutput } from "./lib/hooks-io.mjs";
import { loadConfig, readState } from "./lib/config.mjs";
import { resolveEnforcementMode } from "./lib/enforce.mjs";
import { parseDoDFromDispatch, isCheckable } from "./lib/dod.mjs";
import { runDeterministic } from "./lib/deterministic.mjs";
import { buildForcingNote, nextTierAfter } from "./lib/forcing.mjs";
import { exec as nodeExec } from "node:child_process";
import { access, readFile as fsReadFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Extract the subagent's final return text from a tool_response payload. */
function extractResultText(resp) {
  if (typeof resp === "string") return resp;
  if (!resp || typeof resp !== "object") return "";
  for (const key of ["output", "content", "text", "result"]) {
    const v = resp[key];
    if (typeof v === "string") return v;
  }
  // Nested shapes (e.g. { content: [{ type: "text", text }] })
  if (Array.isArray(resp.content)) {
    return resp.content
      .filter((p) => p && typeof p === "object" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

const execSeam = (command, opts) =>
  new Promise((resolve) => {
    try {
      nodeExec(
        command,
        {
          cwd: opts?.cwd,
          timeout: opts?.timeoutMs ?? 120000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const timedOut = !!(err && err.killed && err.signal === "SIGTERM");
          const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut });
        },
      );
    } catch {
      resolve({ code: 1, stdout: "", stderr: "exec failed", timedOut: false });
    }
  });

let cwd = process.cwd();

const fsSeam = {
  async fileExists(p) {
    try {
      await access(isAbsolute(p) ? p : join(cwd, p));
      return true;
    } catch {
      return false;
    }
  },
  async readFile(p) {
    return await fsReadFile(isAbsolute(p) ? p : join(cwd, p), "utf-8");
  },
};

async function main() {
  const input = readHookInput();
  if (readState()?.bypass === true) return;
  if (typeof input?.tool_name !== "string") return;
  const t = input.tool_name.toLowerCase();
  if (t !== "agent" && t !== "task") return;

  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return;
  }

  let mode = "advisory";
  try {
    mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
  } catch { /* default advisory */ }
  const require = cfg.enforcement?.verify?.require ?? "whenDoDPresent";
  if (mode === "off" || require === "never") return;

  const prompt = typeof input?.tool_input?.prompt === "string" ? input.tool_input.prompt : "";
  const dod = parseDoDFromDispatch(prompt);
  // Deterministic-only gate: no explicit [acceptance] with checks → nothing to verify.
  if (!dod || dod.kind !== "deterministic" || !isCheckable(dod)) return;

  cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();

  const deps = {
    exec: execSeam,
    fs: fsSeam,
    cwd,
    defaults: cfg.verifyDefaults ?? {},
    timeoutMs: 120000,
  };

  let verdict;
  try {
    verdict = await runDeterministic(dod, deps);
  } catch {
    verdict = { pass: false, method: "none", reasons: ["verification failed (fail-closed)"] };
  }
  if (verdict.pass || verdict.skipped) return;

  const producerTier =
    typeof input?.tool_input?.subagent_type === "string" ? input.tool_input.subagent_type : "";
  const ladder = cfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
  const nextTier = nextTierAfter(ladder, producerTier);
  const note = buildForcingNote(verdict.reasons, { producerTier, nextTier });

  emitHookOutput("PostToolUse", { additionalContext: note });
}

main().catch(() => { /* fail-open: a verification error must never throw out of a hook */ });
