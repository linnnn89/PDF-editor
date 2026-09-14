# Installation and runtime paths

The installable package includes its editor under `project/`. Every path below is relative to the directory containing this skill's `SKILL.md`, not to the terminal's current working directory. Moving the entire skill folder preserves the layout.

| Purpose | Relative path |
|---|---|
| Editor project directory | `project/` |
| JavaScript API | `project/src/index.mjs` |
| CLI | `project/src/cli.mjs` |
| Native engine and DLLs | `project/build/bin/` |
| Exact API reference | `project/docs/API.md` |
| Year-label example | `project/scripts/rename-year-labels.mjs` |
| Package identity and version | `project/package.json` |
| Third-party license notices | `project/licenses/` |

Resolve the actual skill-file location to an absolute directory, then set `checkout = path.join(skillRoot, 'project')`. Import the API with `pathToFileURL(path.join(checkout, 'src/index.mjs')).href`; use absolute PDF and output paths. Do not substitute an external development checkout or infer this path from the working directory.

Check that the bundled `package.json` declares `name: "agent-pdf-editor"`. This guide targets the 0.2.8 series; read the bundled `docs/API.md` for the installed contract. The host needs Windows x64 and Node.js `>=24 <25`; Node is not bundled. The package includes runtime DLLs, not a compiler, downloaded build dependencies or research PDFs.

Run `node --version` and `node <checkout>/src/cli.mjs doctor`. Plain doctor does not launch the worker. Current source-built packages also support `doctor --deep`, which starts and closes the worker, reports `ready`, and exits nonzero for missing or incompatible runtimes. For older packages, import `PdfEditor` and `version`, call `await PdfEditor.create()`, compare `editor.engineInfo.version` with `version`, then close in `finally`. Creation rejects JS/native mismatch. Do not claim runtime verification merely from existing files.

If `project/` is absent, only the source skill template was copied. For ordinary use, install the complete prebuilt skill ZIP from the project's [Releases](https://github.com/linnnn89/PDF-editor/releases/tag/v0.2.8-alpha.1); users do not need to compile it. Source development instead uses an existing toolchain, `npm run setup`, `npm run build`, and `npm run skill:pack` as documented in the repository. Honor existing authorization for project-local builds; software installation or dependency downloads require authorization for those actions. Do not patch the host configuration or fall back to an unrelated checkout.
