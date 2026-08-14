---
description: Show or switch routing mode (e.g., /budget budget, /budget quality)
---

Arguments: $ARGUMENTS

Run this command (pass the arguments through, or none when empty) and relay its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/hooks/scripts/cli.mjs" budget $ARGUMENTS
```
