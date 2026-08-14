import { describe, it, expect } from "vitest";
import {
  getActiveTiers,
  getActiveMode,
  buildDelegationProtocol,
  buildDoDProtocolSection,
  assembleSystemPrompt,
  buildTaskTaxonomy,
  buildDecomposeHint,
  isClaudeModel,
} from "../../hooks/scripts/lib/protocol.mjs";

const baseCfg = {
  activePreset: "zai",
  activeMode: "normal",
  presets: {
    zai: {
      fast: { model: "GLM-4.7", costRatio: 1, description: "fast", whenToUse: ["search"] },
      medium: { model: "GLM-5.3", thoughtLevel: "high", costRatio: 5, description: "medium", whenToUse: ["impl"] },
      heavy: { model: "GLM-5.3", thoughtLevel: "max", costRatio: 20, description: "heavy", whenToUse: ["arch"] },
    },
  },
  rules: ["r1", "r2"],
  defaultTier: "medium",
  taskPatterns: {
    fast: ["search", "grep"],
    medium: ["impl"],
    heavy: ["arch"],
  },
  modes: {
    normal: { defaultTier: "medium", description: "balanced" },
    budget: { defaultTier: "fast", description: "cheap", overrideRules: ["b1", "b2"] },
  },
};

describe("getActiveTiers / getActiveMode", () => {
  it("returns the active preset's tiers", () => {
    expect(Object.keys(getActiveTiers(baseCfg))).toEqual(["fast", "medium", "heavy"]);
  });

  it("falls back to the first preset when activePreset is unknown", () => {
    const cfg = { ...baseCfg, activePreset: "nope" };
    expect(getActiveTiers(cfg)).toBe(baseCfg.presets.zai);
  });

  it("returns undefined mode without activeMode", () => {
    expect(getActiveMode({ ...baseCfg, activeMode: undefined })).toBeUndefined();
    expect(getActiveMode(baseCfg).defaultTier).toBe("medium");
  });
});

describe("buildDelegationProtocol", () => {
  const p = buildDelegationProtocol(baseCfg);

  it("mentions the Agent tool, not the opencode Task tool", () => {
    expect(p).toContain('Agent(subagent_type="fast"');
    expect(p).not.toContain("Task(subagent_type");
  });

  it("carries per-tier model + thoughtLevel + costRatio in the tier line", () => {
    expect(p).toContain("@fast=GLM-4.7(1x)");
    expect(p).toContain("@medium=GLM-5.3/high(5x)");
    expect(p).toContain("@heavy=GLM-5.3/max(20x)");
  });

  it("carries mode suffix and taxonomy", () => {
    expect(p).toContain("mode:normal");
    expect(p).toContain("R: @fast→search/grep @medium→impl @heavy→arch");
  });

  it("numbers the active rules", () => {
    expect(p).toContain("1.r1 2.r2");
  });

  it("keeps the protocol compact (< 5500 chars)", () => {
    expect(p.length).toBeLessThan(5500);
  });

  it("uses mode overrideRules instead of global rules in that mode", () => {
    const p2 = buildDelegationProtocol({ ...baseCfg, activeMode: "budget" });
    expect(p2).toContain("1.b1 2.b2");
    expect(p2).not.toContain("1.r1");
    expect(p2).toContain("mode:budget");
  });

  it("includes the decompose hint when the mode has no overrideRules", () => {
    expect(p).toContain("Multi-phase: prefer explore(@fast)→execute(@medium)");
  });

  it("drops the decompose hint when the mode carries overrideRules", () => {
    const p2 = buildDelegationProtocol({ ...baseCfg, activeMode: "budget" });
    expect(p2).not.toContain("Multi-phase:");
  });
});

describe("buildDecomposeHint", () => {
  it("sorts tiers by costRatio to pick explore/execute tiers", () => {
    const hint = buildDecomposeHint({ ...baseCfg, modes: undefined, activeMode: undefined });
    expect(hint).toContain("explore(@fast)→execute(@medium)");
  });
});

describe("buildTaskTaxonomy", () => {
  it("returns empty string without taskPatterns", () => {
    expect(buildTaskTaxonomy({ ...baseCfg, taskPatterns: undefined })).toBe("");
  });
});

describe("DoD section + assembly", () => {
  it("appends the DoD section only when enforcement is on", () => {
    const off = assembleSystemPrompt(baseCfg, undefined, false);
    const on = assembleSystemPrompt(baseCfg, undefined, true);
    expect(off).not.toContain("Acceptance / Definition of Done");
    expect(on).toContain("Acceptance / Definition of Done");
    expect(on).toContain("[acceptance]");
    expect(on.startsWith(off)).toBe(true);
  });

  it("states the explicit-DoD requirement when requireExplicitDoD is set", () => {
    const cfg = { ...baseCfg, enforcement: { verify: { requireExplicitDoD: true } } };
    expect(buildDoDProtocolSection(cfg)).toContain("A DoD is REQUIRED");
  });
});

describe("isClaudeModel", () => {
  it("detects anthropic and claude-via-provider IDs, not GLM", () => {
    expect(isClaudeModel("anthropic/claude-opus-4-8")).toBe(true);
    expect(isClaudeModel("github-copilot/claude-sonnet-4-6")).toBe(true);
    expect(isClaudeModel("bedrock/us.anthropic.claude-3-5-sonnet")).toBe(true);
    expect(isClaudeModel("GLM-5.3")).toBe(false);
    expect(isClaudeModel(undefined)).toBe(false);
  });
});
