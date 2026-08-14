---
description: Show or switch model presets (e.g., /preset zai-turbo)
---

Arguments: $ARGUMENTS

Run this command (pass the arguments through, or none when empty) and relay its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/hooks/scripts/cli.mjs" preset $ARGUMENTS
```

If the output says the preset was switched, follow its instruction: run `scripts/sync-agents.mjs` from the plugin root now, and tell the user a session restart is needed for the regenerated subagents to load.
