# Object edits

The following JavaScript assumes `checkout` resolves to this skill's bundled `project/` as described in [setup](setup.md), absolute `input`, a new absolute `output`, a new absolute `preview`, a user-selected `region` (`{x,y,width,height}`), and requested exact `{from,to}` replacements. Obtain the region and replacement strings from actual inspection and user intent, not this example. All pages are zero-based.

```javascript
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { openDocument, planTextReplacements, summarizeReceipt } =
  await import(pathToFileURL(path.join(checkout, 'src/index.mjs')).href);

const editor = await openDocument(input);
try {
  const page = 0;
  const labels = await editor.query({
    page, type: 'text', withinRectPt: region, limit: 10000,
    fields: ['textSource', 'boundsPt', 'editable',
      'supportedOperations', 'sourceMapping', 'editReason']
  });
  const plan = planTextReplacements(labels, replacements);
  const receipt = await editor.apply({
    ...plan, output,
    textBounds: [{ page, targets: plan.operations.map(op => op.target),
      withinRectPt: region }]
  });
  console.log(summarizeReceipt(receipt));
  await editor.open(receipt.output);
  await editor.render({ page, dpi: 144, output: preview });
} finally {
  await editor.close();
}
```

`fields` limits returned object properties, always including `id` and `type`; it does not remove the initial indexing cost or anonymize selected content. For counts and page geometry alone, `stats({page})` avoids full object details. Do not use `mapping:false` to bypass editability checks.

`planTextReplacements` is a local synchronous helper returning `{sourceSha256, operations}`. It selects by exact `textSource` and requires unique, editable objects supporting `text.replace`. The complete response must have `offset === 0`, `hasMore === false`, and `matched === objects.length`; narrow the query when needed. It rejects ambiguous, missing, unsupported, or invalid targets together in `INVALID_ARGUMENT.details.issues`. It does not join split text objects or perform substring/regex replacement. Each batch contains 1–100 operations, at most one per object. Optional shared style is `{fontSizePt, fill}`; preserve existing styling unless the task asks to change it.

For direct edits, use actual inspected IDs and `expect: {text: object.textSource}`:

```javascript
{ op: 'text.replace', page: 0, target: object.id,
  expect: { text: object.textSource }, value: 'Requested label' }
{ op: 'text.style', page: 0, target: object.id,
  expect: { text: object.textSource }, fontSizePt: 12, fill: '#222222' }
{ op: 'path.style', page: 0, target: object.id,
  strokeWidthPt: 0.65, stroke: '#606060' }
```

Pass these inside `apply({sourceSha256, output, operations})` using the inspected source hash. Read the checkout's `docs/API.md` for the selected operation's restrictions, especially font/encoding support and existing path strokes/fills.

## Region selection and output bounds (0.2.8)

`inspect`/`query` accept `withinRectPt: {x,y,width,height}`. Coordinates are physical pt from the rotated visible page's top-left, with rotation, CropBox offsets, and UserUnit accounted for. The region must fit the page and have positive dimensions. Selection requires full geometric bounds containment with `0.0002` pt tolerance, not mere intersection. Bounds do not resolve every clipping path and do not represent semantic grouping.

Optional `apply.textBounds` is an array of `{page, targets, withinRectPt}` groups. Each target must identify a text edit in the same batch and page, with no repeated constrained target. It cannot accompany crop operations. After saving and reopening the candidate, the engine checks edited text bounds against these rectangles at `0.0002` pt tolerance. Overflow rejects the batch as `TEXT_OUTSIDE_BOUNDS`, with collected `details.issues`; the final output is not published. Successful receipts expose `validation.textBounds: {checkedObjects, tolerancePt}`. These constraints do not resize text automatically. On overflow, inspect the reported geometry and revise only the user-authorized layout choice; do not silently shrink text or widen the allowed region.

## Sessions, receipts, and visual review

An editor retains its opened snapshot after `apply`; reopen `receipt.output` before continuing or rendering the result. Always close sessions. Cancellation/timeout after dispatch terminates the worker, requiring a new session. `STALE_SOURCE` requires reopening and reinspection; `OUTPUT_EXISTS` requires a new name.

Use `summarizeReceipt` for concise reporting; retain full receipts locally when needed. CLI `apply`/`compose` support `--summary --report <new-report-path>`. Report writing and PDF publication are not one transaction: a report failure can leave a valid PDF, so inspect exit status and actual output before retrying. Native checks establish their stated invariants, while visual review of the requested output remains necessary. Show the preview and disclose any appearance check not performed.

## Crop and composition

Read the verified checkout's `docs/API.md` sections `Crop`, `Compose`, and `Geometry` before these less common operations; do not invent schemas.

- Crop uses a separate `apply` batch with `{op:'page.crop', page, rectPt:{x,y,width,height}}`, source hash, and new output. It changes CropBox, not MediaBox. Do not mix it with object edits.
- Composition uses exported `composeFigure({widthPt,heightPt,output,panels})`. Each panel has absolute `file`, `page`, `targetRectPt`, and optionally `sourceRectPt` and inspected `sourceSha256`. Preserve source aspect ratio with the engine's centered `contain` placement. Scaling changes final font sizes and line widths. Labels are not added automatically. Panels with annotations are rejected unless explicitly using `annotations:'exclude'` with the user's intended scope.
- Crop and composition may retain hidden content; neither is redaction.

## Narrow year-label example

If the actual request is changing whole labels of the exact form `Name 2020` to `Name (2020)` inside a chosen column, inspect and invoke the checkout's `scripts/rename-year-labels.mjs` by its resolved absolute path. Its parameters are `--input`, `--output`, `--within-rect x,y,width,height`, optional `--page` (default `0`), and optional `--expected-count` (1–100). Supply a known count when available. It rejects nonmatching selected labels and uses bounds validation. It is an ordinary deterministic example, not a general study-label detector or semantic replacement engine; do not copy its implementation into the installed skill.
