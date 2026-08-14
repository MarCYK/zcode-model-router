import { describe, it, expect } from "vitest";
import { detectNarration } from "../../hooks/scripts/lib/narration.mjs";
import { scrubText } from "../../hooks/scripts/lib/scrub.mjs";
import { fingerprintToolCall } from "../../hooks/scripts/lib/fingerprint.mjs";

describe("detectNarration", () => {
  it("matches the canonical narration phrasings", () => {
    const text =
      "Still writing the auth function. Now I'll implement the tests. Let me add the config. Going to fix the bug. Continuing with the refactor.";
    const found = detectNarration(text);
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found.some((m) => m.toLowerCase().startsWith("still writing"))).toBe(true);
  });

  it("ignores short text and clean text", () => {
    expect(detectNarration("short")).toEqual([]);
    expect(detectNarration("The implementation is complete. All tests pass and files are written.")).toEqual([]);
  });

  it("caps and dedupes matches", () => {
    const spam = Array.from({ length: 10 }, (_, i) => `Still writing the file${i}. Now I'll add tests${i}.`).join(" ");
    const found = detectNarration(spam);
    expect(found.length).toBeLessThanOrEqual(5);
  });
});

describe("scrubText", () => {
  it("redacts key=value secrets and token shapes", () => {
    expect(scrubText('api_key="abc123XYZ789"')).not.toContain("abc123XYZ789");
    expect(scrubText("sk-ant-abcdefghijklmnop1234 rest")).toContain("[REDACTED]");
    expect(scrubText("Bearer abc.def.ghi_jkl_mno_pqr")).toContain("[REDACTED]");
  });

  it("leaves ordinary paths and prose alone", () => {
    const s = "read src/lib/config.mjs and run npm test";
    expect(scrubText(s)).toBe(s);
  });
});

describe("fingerprintToolCall", () => {
  it("keys reads by file path", () => {
    expect(fingerprintToolCall("read", { file_path: "/a" })).toBe("read:/a");
  });

  it("keys greps by pattern+path (different path → different fingerprint)", () => {
    const a = fingerprintToolCall("grep", { pattern: "x", path: "src" });
    const b = fingerprintToolCall("grep", { pattern: "x", path: "lib" });
    expect(a).not.toBe(b);
  });

  it("falls back to serialized args for other tools", () => {
    expect(fingerprintToolCall("ls", { path: "/tmp" })).toBe("ls:/tmp");
    expect(fingerprintToolCall("custom", { a: 1 })).toContain("custom:");
  });
});
