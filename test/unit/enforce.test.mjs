import { describe, it, expect } from "vitest";
import { resolveEnforcementMode, DEFAULT_ENV_GATE } from "../../hooks/scripts/lib/enforce.mjs";

describe("resolveEnforcementMode", () => {
  const cfg = { enforcement: { mode: "advisory" } };

  it("defaults to advisory with no enforcement config", () => {
    expect(resolveEnforcementMode({ config: undefined, env: {} })).toEqual({ mode: "advisory" });
    expect(resolveEnforcementMode({ config: {}, env: {} })).toEqual({ mode: "advisory" });
  });

  it("env gate 1 forces enforced, 0 forces off", () => {
    expect(resolveEnforcementMode({ config: cfg, env: { MODEL_ROUTER_ENFORCE: "1" } })).toEqual({ mode: "enforced" });
    expect(resolveEnforcementMode({ config: cfg, env: { MODEL_ROUTER_ENFORCE: "0" } })).toEqual({ mode: "off" });
  });

  it("unrecognized env value falls through with a warning", () => {
    const r = resolveEnforcementMode({ config: cfg, env: { MODEL_ROUTER_ENFORCE: "yes" } });
    expect(r.mode).toBe("advisory");
    expect(r.warning).toContain('MODEL_ROUTER_ENFORCE="yes"');
  });

  it("perTier overrides the base mode for that tier only", () => {
    const perTier = { enforcement: { mode: "advisory", perTier: { heavy: "off", fast: "enforced" } } };
    expect(resolveEnforcementMode({ config: perTier, tier: "heavy", env: {} }).mode).toBe("off");
    expect(resolveEnforcementMode({ config: perTier, tier: "fast", env: {} }).mode).toBe("enforced");
    expect(resolveEnforcementMode({ config: perTier, tier: "medium", env: {} }).mode).toBe("advisory");
    expect(resolveEnforcementMode({ config: perTier, env: {} }).mode).toBe("advisory");
  });

  it("honours a custom envGate name", () => {
    const custom = { enforcement: { envGate: "ROUTER_MODE", mode: "off" } };
    expect(resolveEnforcementMode({ config: custom, env: { ROUTER_MODE: "1" } })).toEqual({ mode: "enforced" });
  });

  it("default env gate name", () => {
    expect(DEFAULT_ENV_GATE).toBe("MODEL_ROUTER_ENFORCE");
  });
});
