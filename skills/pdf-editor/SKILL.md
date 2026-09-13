---
name: pdf-editor
description: "Edit existing PDF figures with agent-pdf-editor on Windows: replace exact text labels, adjust supported typography or path styles, crop pages, and compose vector panels. Use for edits to existing PDF objects, not OCR or creating figures from data."
---

# PDF figure editor

Use the bundled `project/` for bounded edits to existing PDF figures. The installable package carries the public project and its native engine; Node.js 24 is a host prerequisite. It targets the 0.2.8 API series; verify the package and native version before use.

1. Read [setup](references/setup.md) for the installation-relative paths. Resolve `project/` from the directory containing this `SKILL.md`, never from the working directory or another checkout. If it is absent, this is the source template rather than a complete installation; report that distinction instead of searching whole drives.
2. Read [rules](references/rules.md) before writing. Preserve source files, exact source identity, and the user's requested content scope.
3. Follow [operations](references/operations.md) for inspection, selective fields, exact replacement plans, optional text-bound validation, receipts, and output previews. Its final sections route crop, composition, and the narrow year-label example.

Keep inspection and edits in one session. Select actual object IDs using `textSource`, editability evidence, and the opened `sourceSha256`. Reopen saved outputs before further edits or previews. Use a new absolute output path and close the session in `finally`.

Geometric selection does not identify semantic rows. Bounds validation does not choose font sizes or establish visual quality. Inspect the rendered result against the requested change; report unsupported operations or unverified output appearance explicitly.
