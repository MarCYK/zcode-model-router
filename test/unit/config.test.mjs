import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  validateConfig,
  resolvePresetName,
  loadConfig,
  readState,
  writeState,
  statePath,
  configPath,
  getPluginRoot,
} from "../../hooks/scripts/lib/config.mjs";

const realHome = homedir();
let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "router-config-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

const validCfg = {
  activePreset: "zai",
  presets: {
    zai: {
      fast: { model: "GLM-4.7", description: "d", whenToUse: ["a"] },
    },
  },
  rules: [],
  defaultTier: "medium",
};

describe("validateConfig", () => {
  it("accepts the shipped tiers.json", () => {
    const shipped = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(() => validateConfig(shipped)).not.toThrow();
  });

  it("rejects a non-object root", () => {
    expect(() => validateConfig(null)).toThrow(/JSON object/);
  });

  it("requires activePreset, presets, rules, defaultTier", () => {
    expect(() => validateConfig({ ...validCfg, activePreset: "" })).toThrow(/activePreset/);
    expect(() => validateConfig({ ...validCfg, presets: [] })).toThrow(/presets/);
    expect(() => validateConfig({ ...validCfg, rules: "x" })).toThrow(/rules/);
    expect(() => validateConfig({ ...validCfg, defaultTier: 1 })).toThrow(/defaultTier/);
  });

  it("validates tier shape inside presets", () => {
    const bad = structuredClone(validCfg);
    bad.presets.zai.fast = { description: "d", whenToUse: [] };
    expect(() => validateConfig(bad)).toThrow(/model/);
  });

  it("validates tierCaps as positive integers", () => {
    const bad = { ...validCfg, tierCaps: { fast: 0 } };
    expect(() => validateConfig(bad)).toThrow(/tierCaps/);
  });

  it("validates enforcement.mode enum", () => {
    expect(() => validateConfig({ ...validCfg, enforcement: { mode: "nope" } })).toThrow(/off\|advisory\|enforced/);
    expect(() => validateConfig({ ...validCfg, enforcement: { mode: "enforced" } })).not.toThrow();
  });
});

describe("resolvePresetName", () => {
  it("exact then case-insensitive match", () => {
    expect(resolvePresetName(validCfg, "zai")).toBe("zai");
    expect(resolvePresetName(validCfg, "ZAI")).toBe("zai");
    expect(resolvePresetName(validCfg, "other")).toBeUndefined();
  });
});

describe("state persistence", () => {
  it("writeState merges atomically and readState round-trips", () => {
    writeState({ activeMode: "budget" });
    writeState({ enforcementMode: "enforced" });
    const s = readState();
    expect(s).toMatchObject({ activeMode: "budget", enforcementMode: "enforced" });
    // no .tmp leftovers
    const dir = join(tmpHome, ".zcode", "model-router");
    const files = existsSync(dir) ? readdirSync(dir) : [];
    expect(files.every((f) => !f.includes(".tmp-"))).toBe(true);
  });
});

describe("loadConfig state overlay", () => {
  it("overlays activePreset/activeMode/enforcementMode from state", () => {
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    writeState({ activeMode: "budget", enforcementMode: "off" });
    const cfg = loadConfig();
    expect(cfg.activeMode).toBe("budget");
    expect(cfg.enforcement.mode).toBe("off");
    // activePreset overlay only applies when the preset exists
    writeState({ activePreset: "zai-turbo" });
    expect(loadConfig().activePreset).toBe("zai-turbo");
    writeState({ activePreset: "nonexistent" });
    expect(loadConfig().activePreset).toBe(raw.activePreset);
  });

  it("ignores corrupt state files and keeps tiers.json defaults", () => {
    mkdirSync(join(tmpHome, ".zcode", "model-router"), { recursive: true });
    writeFileSync(statePath(), "{not json", "utf-8");
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("zai");
  });
});

describe("getPluginRoot", () => {
  it("prefers CLAUDE_PLUGIN_ROOT and falls back to the repo layout", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "/tmp/some-plugin";
    expect(getPluginRoot()).toBe("/tmp/some-plugin");
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.ZCODE_PLUGIN_ROOT;
    const root = getPluginRoot();
    expect(existsSync(join(root, "tiers.json"))).toBe(true);
    expect(existsSync(join(root, ".zcode-plugin", "plugin.json"))).toBe(true);
  });
});
