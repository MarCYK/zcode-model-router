// hooks/scripts/lib/enforce.mjs
// Enforcement-mode resolver — pure module, no fs/network/process.env access.
// Port of src/router/enforcement.ts (opencode).

export const DEFAULT_ENV_GATE = "MODEL_ROUTER_ENFORCE";

/**
 * @param {{config?: any, tier?: string, env?: Record<string, string|undefined>}} args
 * @returns {{mode: "off"|"advisory"|"enforced", warning?: string}}
 */
export function resolveEnforcementMode(args) {
  const enf = args.config?.enforcement;
  const gateName = enf?.envGate ?? DEFAULT_ENV_GATE;
  const raw = args.env?.[gateName];

  // Env gate overrides — highest priority
  if (raw === "1") return { mode: "enforced" };
  if (raw === "0") return { mode: "off" };

  // Unrecognized (non-empty, non-undefined) env value → fall through + warn
  let warning;
  if (raw !== undefined && raw !== "") {
    warning = `${gateName}="${raw}" is not "1" or "0"; ignoring env gate and using config.`;
  }

  // Config resolution
  const base = enf?.mode ?? "advisory";
  let mode;
  if (args.tier !== undefined && enf?.perTier?.[args.tier] !== undefined) {
    mode = enf.perTier[args.tier];
  } else {
    mode = base;
  }

  return warning !== undefined ? { mode, warning } : { mode };
}
