# History fragments

A change records its [history.md](../history.md) rows here, one file per change, so branches never conflict on that page.

- File name: `<yyyy-mm-dd>-<slug>.md` (lowercase letters, digits and dashes; slug up to 60 characters). This file is the only exception.
- Content: an optional first line `section: <heading text>` (the `## ` section the rows go under; default: the last one), then rows `| (this change) | <what changed, in plain words> | [page](link) |`. The third column may be empty; write a `|` inside text as `\|`.
- Links are paths relative to `docs/` and must exist (`reference/api.md#anchor`); absolute URLs are not checked.
- Never edit `docs/history.md` on a package branch. `pnpm check:history` validates fragments; the integrator runs `pnpm history:assemble` once per wave.

Example:

```
section: 2026-11-21: combined wave 1
| (this change) | What the change did, in plain words | [development.md](development.md#history-fragments) |
```

See [development.md](../development.md#history-fragments).
