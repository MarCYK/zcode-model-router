// hooks/scripts/lib/forcing.mjs
// Advisory forcing notes for unaccepted delegation results.
// Port of buildForcingNote from src/verify/dispatch.ts (opencode). The zcode
// runtime cannot retry a finished delegation (no programmatic session API),
// so the note is advisory: it tells the orchestrator what to do next.

import { scrubText } from "./scrub.mjs";

/** Build the advisory forcing note appended to a task result the gate did not accept. */
export function buildForcingNote(reasons, escalation) {
  const body =
    reasons.length > 0
      ? reasons.map((r) => `- ${r}`).join("\n")
      : "- (no reasons provided)";
  const next = escalation?.nextTier
    ? `NEXT: address the above, then re-dispatch via \`Agent(subagent_type="${escalation.nextTier}")\`` +
      `${escalation.producerTier ? ` (escalated from ${escalation.producerTier})` : ""}; ` +
      `do not treat the prior result as complete.`
    : `NEXT: address the above and re-run the delegation; do not treat the prior result as complete.`;
  return (
    `[router ⚠ NOT ACCEPTED] The delegated result was not accepted by deterministic verification:\n` +
    `${scrubText(body)}\n` +
    next
  );
}

/** Next tier on the escalation ladder after producerTier (null when already at the top). */
export function nextTierAfter(ladder, producerTier) {
  const li = ladder.indexOf(producerTier);
  if (li < 0 || li >= ladder.length - 1) return null;
  return ladder[li + 1];
}
