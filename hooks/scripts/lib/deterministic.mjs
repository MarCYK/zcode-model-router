// hooks/scripts/lib/deterministic.mjs
// Deterministic verifier: runs DoD checks using injected seams (no real
// fs/exec imports at module level). Port of src/verify/deterministic.ts.
// PURE: all I/O goes through DeterministicDeps seams.

import { scrubText } from "./scrub.mjs";

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWLIST = [
  "npm", "npx", "pnpm", "yarn", "bun", "node",
  "tsc", "tsx", "vitest", "jest", "eslint", "prettier",
];

// Any shell-chaining / redirection / substitution metacharacter.
export const FORBIDDEN_SHELL = /[;&|`$><\n]|\$\(|&&|\|\|/;

// Interpreters that can execute arbitrary inline code via a flag. An
// allowlisted interpreter must not be turned into an arbitrary-code runner.
const INTERPRETERS = new Set([
  "node", "deno", "bun", "tsx", "ts-node", "python", "python3", "ruby", "perl",
]);
// Inline-eval / inline-print flags: -e, -c, -p, --eval, --print (with optional =value).
const EVAL_FLAG_RE = /^-(e|c|p)$|^--(eval|print)(=|$)/i;

export function isCommandAllowed(command, allowlist) {
  const trimmed = command.trim();
  if (!trimmed || FORBIDDEN_SHELL.test(command)) return false;
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const parts = firstToken.split(/[/\\]/);
  const basename = parts[parts.length - 1];
  if (!allowlist.includes(basename)) return false;
  const interpreterBase = basename.replace(/\.(exe|cmd|bat)$/i, "");
  if (INTERPRETERS.has(interpreterBase)) {
    for (const t of tokens.slice(1)) {
      if (EVAL_FLAG_RE.test(t)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shape check (exported for unit testing)
// ---------------------------------------------------------------------------

export function shapeMismatch(schemaVal, targetVal, path = "") {
  if (schemaVal !== null && typeof schemaVal === "object" && !Array.isArray(schemaVal)) {
    if (targetVal === null || typeof targetVal !== "object" || Array.isArray(targetVal)) {
      return `${path || "<root>"}: expected object`;
    }
    for (const k of Object.keys(schemaVal)) {
      if (!(k in targetVal)) return `${path}${k}: missing`;
      const nested = shapeMismatch(schemaVal[k], targetVal[k], `${path}${k}.`);
      if (nested !== null) return nested;
    }
    return null;
  } else if (Array.isArray(schemaVal)) {
    if (!Array.isArray(targetVal)) return `${path || "<root>"}: expected array`;
    return null; // presence of array suffices; elements/length not checked
  } else {
    if (typeof schemaVal !== typeof targetVal) {
      return `${path || "<root>"}: expected ${typeof schemaVal}, got ${typeof targetVal}`;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-kind runners
// ---------------------------------------------------------------------------

async function runFileExists(check, deps) {
  try {
    if (!check.path) return { ok: false, reason: "fileExists check missing 'path'" };
    const ok = await deps.fs.fileExists(check.path);
    if (ok) return { ok: true, evidence: `exists: ${check.path}` };
    return { ok: false, reason: `file not found: ${check.path}` };
  } catch (err) {
    return { ok: false, reason: `fileExists check errored: ${scrubText(String(err))}` };
  }
}

async function runRun(check, deps, allowlist, timeoutMs) {
  try {
    if (!check.command) return { ok: false, reason: "run check missing 'command'" };
    if (!isCommandAllowed(check.command, allowlist)) {
      return { ok: false, reason: `command not allowlisted: ${check.command}` };
    }
    const r = await deps.exec(check.command, { cwd: deps.cwd, timeoutMs });
    if (r.timedOut) {
      return { ok: false, reason: `run timed out after ${timeoutMs}ms: ${check.command}` };
    }
    const out = r.stdout + "\n" + r.stderr;
    if (check.expect !== undefined && !out.includes(check.expect)) {
      return {
        ok: false,
        reason: `expected substring not found: "${check.expect}"`,
        evidence: out.slice(0, 2000),
      };
    }
    if (r.code !== 0) {
      return { ok: false, reason: `command exited ${r.code}: ${check.command}`, evidence: out.slice(0, 2000) };
    }
    return { ok: true, evidence: `exit 0: ${check.command}` };
  } catch (err) {
    return { ok: false, reason: `run check errored: ${scrubText(String(err))}` };
  }
}

function resolveRepoCommand(check, kind, defaults) {
  if (check.command) return check.command;
  if (kind === "testsPass") return defaults?.testCommand ?? "npm test";
  if (kind === "buildPasses") return defaults?.buildCommand ?? "npm run build";
  return defaults?.lintCommand ?? "npm run lint";
}

async function runCommandCheck(check, kind, deps, allowlist, timeoutMs) {
  const command = resolveRepoCommand(check, kind, deps.defaults);
  const fn = async () => {
    try {
      if (!isCommandAllowed(command, allowlist)) {
        return { ok: false, reason: `command not allowlisted: ${command}` };
      }
      const r = await deps.exec(command, { cwd: deps.cwd, timeoutMs });
      if (r.timedOut) {
        return { ok: false, reason: `${kind} timed out after ${timeoutMs}ms: ${command}` };
      }
      const out = r.stdout + "\n" + r.stderr;
      if (r.code !== 0) {
        return { ok: false, reason: `command exited ${r.code}: ${command}`, evidence: out.slice(0, 2000) };
      }
      return { ok: true, evidence: `exit 0: ${command}` };
    } catch (err) {
      return { ok: false, reason: `${kind} check errored: ${scrubText(String(err))}` };
    }
  };
  return fn();
}

async function runSchemaMatch(check, deps) {
  try {
    if (!check.path || !check.schema) {
      return { ok: false, reason: "schemaMatch requires 'path' and 'schema'" };
    }
    const targetRaw = await deps.fs.readFile(check.path);
    let targetVal;
    try {
      targetVal = JSON.parse(targetRaw);
    } catch {
      return { ok: false, reason: `target is not valid JSON: ${check.path}` };
    }

    let schemaVal;
    if (check.schema.trim().startsWith("{")) {
      try {
        schemaVal = JSON.parse(check.schema);
      } catch {
        return { ok: false, reason: "schema is not valid JSON" };
      }
    } else {
      const schemaRaw = await deps.fs.readFile(check.schema);
      try {
        schemaVal = JSON.parse(schemaRaw);
      } catch {
        return { ok: false, reason: "schema is not valid JSON" };
      }
    }

    const mismatch = shapeMismatch(schemaVal, targetVal);
    if (mismatch !== null) {
      return { ok: false, reason: `schema mismatch at ${mismatch}`, evidence: mismatch };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `schemaMatch check errored: ${scrubText(String(err))}` };
  }
}

// ---------------------------------------------------------------------------
// runDeterministic
// ---------------------------------------------------------------------------

export async function runDeterministic(dod, deps) {
  const checks = dod.checks ?? [];

  if (checks.length === 0) {
    return {
      pass: false,
      method: "none",
      skipped: true,
      reasons: ["no deterministic checks to run"],
    };
  }

  const timeoutMs = deps.timeoutMs ?? 120000;
  const allowlist = deps.allowlist ?? DEFAULT_ALLOWLIST;
  const results = [];

  for (const check of checks) {
    let result;
    switch (check.kind) {
      case "fileExists":
        result = await runFileExists(check, deps);
        break;
      case "run":
        result = await runRun(check, deps, allowlist, timeoutMs);
        break;
      case "testsPass":
      case "buildPasses":
      case "lintClean":
        result = await runCommandCheck(check, check.kind, deps, allowlist, timeoutMs);
        break;
      case "schemaMatch":
        result = await runSchemaMatch(check, deps);
        break;
      default:
        result = { ok: false, reason: `unknown check kind: ${check.kind}` };
        break;
    }
    results.push(result);
  }

  const allPass = results.every((r) => r.ok);

  const reasons = allPass
    ? [`all ${checks.length} deterministic checks passed`]
    : results.filter((r) => !r.ok).map((r) => scrubText(r.reason ?? "check failed"));

  const evidenceParts = results.map((r) => r.evidence ?? "").filter((e) => e.length > 0);
  const rawEvidence = evidenceParts.length > 0 ? evidenceParts.join("\n---\n") : undefined;
  const evidence = rawEvidence !== undefined ? scrubText(rawEvidence) : undefined;

  return {
    pass: allPass,
    method: "deterministic",
    reasons,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}
