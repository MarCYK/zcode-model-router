---
description: Annotate a plan with [tier:fast/medium/heavy] delegation tags
---

Annotate the plan with tier directives for model delegation.

Plan file: "$ARGUMENTS"
If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.

## Available tiers

- `[tier:fast]` — Fast/cheap model (GLM-4.7): exploration, search, file reads, grep, listing, research. Agent does NOT edit code.
- `[tier:medium]` — Balanced model (GLM-5.3 high): implementation, refactoring, tests, code review, bug fixes, standard coding tasks.
- `[tier:heavy]` — Most capable model (GLM-5.3 max): architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.

## Annotation rules

1. Place `[tier:X]` at the START of each step, before the description
2. Research/exploration -> `[tier:fast]` (preferred)
3. Implementation/code -> `[tier:medium]` (preferred)
4. Architecture/security/hard debugging -> `[tier:heavy]`
5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity
6. Verification (run tests, build) -> `[tier:medium]`
7. Trivial (single grep or file read) -> `[tier:fast]`
8. Final review of the complete plan -> `[tier:heavy]`

## Output

Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.

## Acceptance blocks (for enforcement)

For each NON-TRIVIAL task, append an acceptance block immediately after the step so the router can deterministically verify the work:

[acceptance]
check: <testsPass | buildPasses | lintClean | fileExists path=... | run command="..." expect=...>
criteria: <plain-language success condition, when no deterministic check applies>
deliverable: <path or short description>
[/acceptance]

Prefer deterministic checks (testsPass/buildPasses/fileExists). Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block.
