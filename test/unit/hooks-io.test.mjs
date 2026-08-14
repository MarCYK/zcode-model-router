import { describe, it, expect } from "vitest";
import { emitHookOutput, toolKey } from "../../hooks/scripts/lib/hooks-io.mjs";

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    chunks.push(s);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

describe("emitHookOutput", () => {
  it("emits exactly the schema keys for UserPromptSubmit", () => {
    const out = captureStdout(() => emitHookOutput("UserPromptSubmit", { additionalContext: "hello" }));
    expect(JSON.parse(out)).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: "hello" });
  });

  it("adds permissionDecision keys only for PreToolUse", () => {
    const out = captureStdout(() =>
      emitHookOutput("PreToolUse", {
        additionalContext: "ctx",
        permissionDecision: "deny",
        permissionDecisionReason: "why",
      }),
    );
    expect(JSON.parse(out)).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: "ctx",
      permissionDecision: "deny",
      permissionDecisionReason: "why",
    });

    const out2 = captureStdout(() =>
      emitHookOutput("PostToolUse", { additionalContext: "x", permissionDecision: "deny" }),
    );
    expect(JSON.parse(out2)).toEqual({ hookEventName: "PostToolUse", additionalContext: "x" });
  });

  it("drops undefined fields and stays silent for unknown events", () => {
    const out = captureStdout(() => emitHookOutput("Stop", { additionalContext: undefined }));
    expect(JSON.parse(out)).toEqual({ hookEventName: "Stop" });
    const none = captureStdout(() => emitHookOutput("NotAnEvent", { additionalContext: "x" }));
    expect(none).toBe("");
  });
});

describe("toolKey", () => {
  it("lowercases zcode PascalCase tool names", () => {
    expect(toolKey("Read")).toBe("read");
    expect(toolKey("Grep")).toBe("grep");
    expect(toolKey(undefined)).toBe("");
  });
});
