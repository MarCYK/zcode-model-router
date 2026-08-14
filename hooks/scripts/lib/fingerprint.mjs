// hooks/scripts/lib/fingerprint.mjs
// Fingerprint a read-only tool call for redundancy detection.
// Port of src/guard/fingerprint.ts (opencode) — zcode tool args use the same
// field names (file_path, pattern, path, glob).

export function fingerprintToolCall(tool, args) {
  const a = (args ?? {}) ?? {};
  switch (tool) {
    case "read":
      return `read:${a.file_path ?? a.filePath ?? ""}`;
    case "grep":
      return `grep:${a.pattern ?? ""}:${a.path ?? a.glob ?? ""}`;
    case "glob":
      return `glob:${a.pattern ?? ""}:${a.path ?? ""}`;
    case "ls":
      return `ls:${a.path ?? ""}`;
    default:
      return `${tool}:${JSON.stringify(a).slice(0, 120)}`;
  }
}
