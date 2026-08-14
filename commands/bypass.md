---
description: Toggle model-router bypass (disables delegation protocol for this and future sessions until toggled off)
---

Arguments: $ARGUMENTS

Run this command (pass "on" or "off" through, or none to toggle) and relay its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/hooks/scripts/cli.mjs" bypass $ARGUMENTS
```
