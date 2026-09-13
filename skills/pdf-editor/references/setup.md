# Locate and verify the engine

The copied skill is standalone guidance, but executing it requires a separate, compiled `agent-pdf-editor` repository, Windows x64, and Node.js `>=24 <25`. It does not bundle the native worker, libraries, fonts, or sample PDFs.

Use the current working directory if `package.json` declares `name: "agent-pdf-editor"`; otherwise use the checkout explicitly supplied by the user. Resolve that checkout to an absolute path. If neither identifies it, ask for the path. Do not scan drives, infer a checkout from the installed skill's parent directories, or change host configuration.

Read the verified checkout's `package.json` and `docs/API.md` for its exact version and supported contract. This guide covers the 0.2.8 series, including `0.2.8-alpha.1`; feature availability follows the actual installed code. Resolve repository files such as `src/index.mjs`, `src/cli.mjs`, and `scripts/rename-year-labels.mjs` against the verified checkout, never against the installed skill directory.

Run `node --version` and, from the checkout, `node src/cli.mjs doctor`. Doctor checks prerequisites and executable presence but does not launch the worker. For a real runtime check, import `PdfEditor` and `version` from the checkout's `src/index.mjs`, call `await PdfEditor.create()`, compare `editor.engineInfo.version` with `version`, and close in `finally`. Creation itself rejects JS/native mismatch; a file on disk is not evidence that a connected client loaded it.

For scripts outside the checkout, import using `pathToFileURL(path.join(checkout, 'src/index.mjs')).href`; the `checkout` variable must be the verified absolute path. Use absolute input/output paths too.

If runtime or build artifacts are missing/mismatched, inspect the checkout's own setup instructions and report the precise prerequisite. An ordinary project-local rebuild using an existing toolchain may follow the task's existing authorization; do not ask again for work already authorized. Software installation, dependency downloads or Node/environment changes require authorization for those actions. Installing this skill alone requires none of them.
