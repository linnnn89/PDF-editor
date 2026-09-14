# Agent PDF Editor

**Edit the PDF figure you already have.** Correct labels, adjust typography and line styles, trim margins, and combine panels while keeping vector content.

[English](README.md) · [简体中文](README.zh-CN.md)

![Status: alpha](https://img.shields.io/badge/status-alpha-orange)
![Windows x64](https://img.shields.io/badge/platform-Windows_x64-blue)
![Node.js 24](https://img.shields.io/badge/Node.js-24-417E38)

Agent PDF Editor is a local CLI and JavaScript API for researchers and agent developers who need targeted changes to existing PDF figures. It edits supported PDF objects directly, without an SVG round trip or regenerating the chart from data.

> **Current version: 0.2.8-alpha.1.** Windows x64 with Node.js 24. Download the ready-to-use skill ZIP below; no compilation is needed. This is a CLI/API toolkit without a desktop GUI. Editing support depends on the input PDF's structure and fonts.

[Quick start](#quick-start) · [JavaScript example](#javascript-example) · [Capabilities](#capabilities) · [API reference](docs/API.md)

## Which download do I need?

| Your goal | Download | What's included | Compile? |
|---|---|---|---|
| **Use the editor with an agent or CLI** | [Prebuilt skill ZIP](https://github.com/linnnn89/PDF-editor/releases/download/v0.2.8-alpha.1/pdf-editor-skill-v0.2.8-alpha.1-win-x64.zip) | Skill entrypoint and manuals; public editor project with JS API/CLI; compiled EXE, required DLLs, and third-party notices | **No** |
| **Modify or develop the editor** | [Source code ZIP](https://github.com/linnnn89/PDF-editor/archive/refs/tags/v0.2.8-alpha.1.zip) or `git clone` | C++/JS source, tests, documentation, build/packaging scripts, and skill template | **Yes, for the native engine**; no prebuilt download needed |

The prebuilt package does **not** include Node.js, a compiler, private PDFs, Git history, or build caches. Windows x64 and host-provided **Node.js 24** are required to run it. GitHub's **Code → Download ZIP** and **Source code** release archives contain source, not a ready-to-run installation.

## See it work

Correct `Panle A` to `Panel A`, increase the label from 12 to 18 pt, and change the rule from 0.75 to 1.5 pt. Other objects remain unchanged.

| Before | After |
|---|---|
| ![Synthetic PDF before editing: a small label with a typo and a thin gray rule](docs/assets/demo-before.png) | ![Synthetic PDF after editing: the corrected blue label and a thicker blue rule](docs/assets/demo-after.png) |

These previews come from a **generated synthetic fixture**, not a research document. Run `node scripts/demo.mjs` from the installed `project/` directory to produce the PDFs, previews, and validation receipt locally. Each run uses a new output directory.

## What you can do

- **Fix a figure label:** replace text, change font size, and adjust its color.
- **Improve readability:** change path stroke widths and colors without rebuilding the chart.
- **Prepare a multi-panel figure:** place pages or selected regions from several PDFs onto a new canvas, preserving their vector content.
- **Adjust visible margins:** crop using physical page coordinates, or compose onto a larger canvas to add space.
- **Automate repeatable edits:** inspect objects, submit a batch with explicit preconditions, and inspect the saved output and receipt.

## Quick start

You need **Windows x64**, **Node.js 24**, and an **NTFS output directory**. There are no third-party npm packages to install.

1. Download [pdf-editor-skill-v0.2.8-alpha.1-win-x64.zip](https://github.com/linnnn89/PDF-editor/releases/download/v0.2.8-alpha.1/pdf-editor-skill-v0.2.8-alpha.1-win-x64.zip) from [Releases](https://github.com/linnnn89/PDF-editor/releases/tag/v0.2.8-alpha.1). Choose this asset, not GitHub's automatic **Source code** archive.
2. Extract the contained `pdf-editor/` folder into your agent host's skills directory, such as `~/.agents/skills/`. Back up an existing installation outside that discovery directory before replacing it.
3. Refresh skills or start a new agent session and use `$pdf-editor`. The folder includes the compiled EXE/DLLs and resolves the API through its own `project/` directory. **No compiler, build step or development checkout is required.**

To try it without an agent, open a terminal in the extracted `pdf-editor/project/` directory:

```powershell
node src/cli.mjs doctor
node scripts/demo.mjs
```

The demo prints the paths to its before/after PDFs, PNG previews, and output directory. Processing is local; the editor does not call an AI service or upload PDFs. A separate agent host controls its own model calls and what tool output it sends to a model.

### Build from source (developers)

Download source or clone the repository; you do not need the prebuilt package. Use an existing Visual Studio C++ x64 toolchain, Windows SDK, CMake 3.24+, and Ninja. The build script discovers Visual Studio and its bundled CMake/Ninja, with a PATH fallback for the latter two.

```powershell
git clone https://github.com/linnnn89/PDF-editor.git
cd PDF-editor
npm run setup
npm run build
npm run skill:pack
```

`setup` downloads about 33 MB of pinned native dependencies into `vendor/`, verifies their SHA-256 checksums, and creates the ignored `test pdf/` directory. It does not install system tools or change global configuration. `skill:pack` creates a new self-contained skill directory using a public-file allowlist and the built runtime; it performs no downloads. See [packaging instructions](skills/README.md).

Current source builds add `node src/cli.mjs doctor --deep`, which starts the native engine to check its version and library loading, exiting with status 1 on failure. `skill:pack` verifies the packaged file manifest and runs the inspect/edit/reopen/render demo from a relocated directory containing Unicode and spaces. Verification outputs stay in `artifacts/package-checks/`, outside the distributable package. The Windows CI workflow uses the same build, test and package-verification commands.

### Use your own PDF

Place your file at `test pdf/figure.pdf`, then inspect it and generate a preview:

```powershell
node src/cli.mjs stats "test pdf/figure.pdf" --page 0
node src/cli.mjs inspect "test pdf/figure.pdf" --limit 20
node src/cli.mjs query "test pdf/figure.pdf" --type text --text "Study" --fields textSource,editable,supportedOperations
node src/cli.mjs query "test pdf/figure.pdf" --type path --editable
node src/cli.mjs render "test pdf/figure.pdf" --output "output/preview.png" --dpi 144
```

Choose a new output name for each write. Existing files are never overwritten. CLI results are JSON on stdout; errors are JSON on stderr. When consuming JSON, call `node src/cli.mjs` directly to avoid npm's own console output.

Agents can start with `stats` for page dimensions and object counts, then use `query` to select targets. `stats` skips text, font and source-mapping extraction, counts nested panel contents, and does not determine editability. It still parses the page; use `query` or `inspect` for object details.

Use `fields` (CLI `--fields`) to return only the object properties needed for the task. IDs and types are always included; filtering, pagination and edit validation stay the same. Omitting `fields` returns full details. This reduces response size, not the first page-indexing cost, and does not require an extra query before editing.

For agent workflows, use `apply` or `compose` with `--summary --report output/receipt.json`: the model receives a compact result while the full receipt stays in a new local file. Without these options, the existing full JSON output is preserved. See [receipt handling](docs/API.md#compact-receipts--简短回执) for failure and privacy boundaries.

## JavaScript example

Save this as `edit.mjs` in the installed `project/` directory or the built repository root. Change the input path and label to match your PDF. The target must be an editable text object; unsupported fonts or characters produce a specific error.

```javascript
import path from 'node:path';
import { openDocument } from './src/index.mjs';

const editor = await openDocument(path.resolve('test pdf/figure.pdf'));
try {
  const result = await editor.query({ page: 0, type: 'text', text: 'Study' });
  const matches = result.objects.filter(o => o.editable && o.textSource === 'Study');
  if (result.hasMore || matches.length !== 1) throw new Error('Select one exact editable label');
  const label = matches[0];

  const receipt = await editor.apply({
    sourceSha256: result.source.sha256,
    output: path.resolve('output/figure-edited.pdf'),
    operations: [{
      op: 'text.replace', page: 0, target: label.id,
      expect: { text: label.textSource }, value: 'Studies',
      fontSizePt: 15, fill: '#1D4ED8'
    }]
  });
  console.log(receipt.output);
} finally {
  await editor.close();
}
```

Pages are **zero-based**. Coordinates use physical **pt** from the top-left of the rotated visible page; 1 pt is 1/72 inch. Use object IDs and `textSource` from the current inspection, rather than guessing them.

For several edits, keep one JS session open and batch the operations. A session always edits its opened snapshot: reopen the saved output to continue editing that result. See the [API reference](docs/API.md) for cropping, composition, pagination, cancellation, and error handling.

**Replacing a whole list of labels?** Pass a complete query and an explicit old/new name list to `planTextReplacements()`, then submit the returned operations in one `apply()`. Shared size/color settings apply to every label. Missing, ambiguous and unsupported targets are reported together before a plan is returned. It matches complete source text within the query; it does not infer study rows or join fragmented text. See [batch label replacement](docs/API.md#batch-label-replacement--批量替换标签).

To work within one column, use `query({ withinRectPt })` (CLI: `--within-rect x,y,width,height`). To require edited labels to stay inside that column, also pass `textBounds` to `apply`. These are separate, optional controls: selection uses original geometry; the guard checks the reopened output and reports all out-of-bounds targets without publishing that result. It does not resize text automatically. See [scoped edits](docs/API.md#text-boundary-guards--文字范围约束) and the [local year-formatting example](scripts/rename-year-labels.mjs).

## Install the agent skill

Use the prebuilt ZIP in [Quick start](#quick-start). It includes the editor project and native runtime under `project/`; the thin entrypoint uses installation-relative paths, so moving the entire folder preserves its references. Windows x64 and Node.js 24 are required. See [installation instructions](skills/README.md); the repository's `skills/pdf-editor/` is the source template, not the complete runtime package.

## Capabilities

| Task | Current support |
|---|---|
| Inspect text, paths, images, fonts, and nested Forms | Read geometry, styles, and explicit editability reasons |
| Replace text or adjust size/color | Uniquely mapped, top-level horizontal text; verified character reuse and supported TrueType font extension |
| Change line width, stroke color, or fill color | Supported paths; physical stroke width requires a uniform orthogonal transform |
| Crop visible page margins | `page.crop`; changes CropBox while preserving source streams |
| Combine pages or regions | Up to 32 panels on a new page, with proportional placement and preserved vector content |
| Render previews | PNG at 36–600 dpi, up to 40 megapixels per render |
| Move line endpoints, replace images, or edit inside nested Forms | Not implemented; inspection remains available |
| Change font families, OCR a scan, or perform complex text shaping | Not implemented |

## Validation and limits

Source builds also accept simple Type1/TrueType encoding dictionaries with
WinAnsi or the supported StandardEncoding subset, plus verified `Differences`
glyph names. Mathematical minus (`−`) and hyphen (`-`) remain distinct.
Read-only objects provide `editReasonCode` for programmatic diagnostics; see
[encoding support and limits](docs/API.md#simple-font-encoding-dictionaries--简单字体编码字典).

Writes use a new file and reject changed inputs or existing destinations. Object edits are reopened and checked against the requested changes, original streams, and untouched objects. A PDFium comparison at **144 dpi** requires zero changed pixels outside the allowed target regions, including a fixed antialiasing margin.

This checks editing boundaries; it does not judge whether a longer label overlaps a neighbor or whether a layout looks good. Review the preview before using a figure in a manuscript or presentation.

Saving losslessly compresses eligible new streams, including page content, font maps, and panel wrappers. Original content/resource streams and imported image, font, and nested Form resources retain their encoding. Images are not downsampled and old content is not removed. File size depends on the source structure and added fonts; an edit is not guaranteed to produce a smaller file than its input.

Composition shares identical embedded TrueType programs across panel inputs after comparing their stream dictionaries and encoded bytes. Font descriptors, character maps, and widths remain separate. The receipt reports sharing statistics; these are not a measurement of the final file-size reduction. Object edits and cropping keep their original stream-preservation behavior.

- Text keeps its original baseline origin. Automatic reflow, centering, and fitting are not provided.
- Font extension verifies glyphs, widths, and embedding permissions. Supported embedded Identity-H TrueType resources are reused after verifying the requested characters' codes, glyph IDs, and advances. Adding a full font can still increase file size; unsupported reuse cases fall back to an independent font resource.
- Composed panels contain nested Forms. To revise their internal labels, edit the inputs or pre-composition plan and compose again.
- Encrypted PDFs are not supported. Signed PDFs and files with parsing-repair warnings cannot be edited.
- Colors are DeviceRGB; ICC/CMYK prepress conversion and cross-reader rendering equivalence are not guaranteed.
- **This is not a redaction tool.** Cropping and composition can retain hidden content, and text replacement retains original streams. Never use these operations to remove confidential information.

## Development and local data

```powershell
npm test
npm run bench -- --dir "test pdf" --runs 10
npm run bench:edits -- --dir "test pdf" --runs 5
npm run bench:batch -- --input "test pdf/figure.pdf" --replacements "test pdf/names.json" --runs 5
```

Tests generate their own PDFs. Font-extension tests use locally installed Arial regular and bold; font files are not bundled. Benchmarks use your own local samples and write reports under `artifacts/`. They measure local processing, not agent reasoning or model latency.

Source builds return `timingsMs` for queries and object edits, separating native indexing, mapping, saving, reopening and validation phases. The `bench:edits` and `bench:batch` JSON reports retain these measurements. They exclude JS hashing, IPC serialization and final publication; use the existing wall-clock measurements for end-to-end comparisons. See [API details](docs/API.md#native-phase-timings--原生分阶段耗时).

The batch benchmark takes a JSON array of `{ "from": "Author 2020", "to": "Author (2020)" }` entries for your selected page. It compares one label, half the list and the complete list, checking reopened text, pixels outside targets and the unchanged input hash. Request sizes are UTF-8 bytes, not model tokens. Keep name lists with private PDFs in `test pdf/`.

PDFs, local research directories, credentials, generated outputs, downloaded dependencies, and build products are ignored by Git. Benchmark reports and editing receipts may contain extracted text and local paths: keep them local, and review attachments before sharing an issue.

The engine uses **JavaScript / Node.js 24 + C++20**, with [PDFium](https://pdfium.googlesource.com/pdfium/) for reading and rendering, [QPDF](https://github.com/qpdf/qpdf) for writing, and [nlohmann/json](https://github.com/nlohmann/json) for JSON. Versions, download URLs, and checksums are pinned in [dependencies.lock.json](dependencies.lock.json); third-party license notices remain with the downloaded dependencies. No project license has been selected yet.

Bug reports are welcome in [GitHub Issues](https://github.com/linnnn89/PDF-editor/issues). Include the version, command, expected behavior, and error code. Prefer a synthetic reproduction over a confidential PDF.
