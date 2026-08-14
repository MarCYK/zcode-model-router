---
description: Model-router controls (e.g., /router enforce off|advisory|enforced)
---

Arguments: $ARGUMENTS

Run this command (pass the arguments through, or none for status) and relay its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/hooks/scripts/cli.mjs" router $ARGUMENTS
```
