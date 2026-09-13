import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256, version } from '../src/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: {
  dir: { type: 'string' },
  runs: { type: 'string', default: '5' },
} });
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 30) throw new Error('--runs must be an integer from 1 to 30');

const input = path.resolve(values.dir ?? path.join(root, 'test pdf'));
const timestamp = new Date().toISOString().replaceAll(':', '-');
const destination = path.join(root, 'artifacts', 'benchmarks-edits', timestamp);
await mkdir(input, { recursive: true });
await mkdir(destination, { recursive: true });

async function listPdfs(dir) {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const itemPath = path.join(dir, item.name);
    if (item.isDirectory()) result.push(...await listPdfs(itemPath));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) result.push(itemPath);
  }
  return result.sort();
}

function stats(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    medianMs: sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

async function timed(action, samples) {
  const start = performance.now();
  const result = await action();
  samples.push(performance.now() - start);
  return result;
}

function errorDetails(error) {
  return { code: error?.code ?? 'ERROR', message: error?.message ?? String(error) };
}

function supports(object, operation) {
  return object.editable === true && object.supportedOperations?.includes(operation);
}

function textCandidates(objects, operation, minimumLength = 1) {
  return objects.filter(object => {
    const text = object.textSource;
    return object.type === 'text'
      && supports(object, operation)
      && typeof text === 'string'
      && text.length >= minimumLength
      && text.length <= 12
      && /^[A-Za-z]+$/.test(text);
  }).sort((a, b) => a.textSource.length - b.textSource.length || a.id.localeCompare(b.id));
}

function selectCandidates(objects) {
  const style = textCandidates(objects, 'text.style').find(object =>
    Number.isFinite(object.fontSizeYPt) && object.fontSizeYPt > 0 && object.fontSizeYPt * 1.1 <= 300);
  const replace = textCandidates(objects, 'text.replace', 2).find(object => {
    const value = object.textSource.at(-1) + object.textSource.slice(1, -1) + object.textSource[0];
    return value !== object.textSource
      && typeof object.reusableCharacters === 'string'
      && [...value].every(character => object.reusableCharacters.includes(character));
  });
  const pathObject = objects.filter(object => object.type === 'path'
    && supports(object, 'path.style')
    && Number.isFinite(object.strokeWidthPt)
    && object.strokeWidthPt > 0
    && Number.isInteger(object.segmentCount)
    && object.segmentCount <= 3
    && object.strokeWidthPt * 1.2 <= 100)
    .sort((a, b) => a.segmentCount - b.segmentCount || a.id.localeCompare(b.id))[0];
  return { style, replace, path: pathObject };
}

function operationDefinitions(candidates) {
  const definitions = [];
  if (candidates.style) definitions.push({
    key: 'textStyle',
    candidate: candidates.style,
    operation: {
      op: 'text.style', page: 0, target: candidates.style.id,
      expect: { text: candidates.style.textSource },
      fontSizePt: candidates.style.fontSizeYPt * 1.1,
    },
  });
  if (candidates.replace) {
    const text = candidates.replace.textSource;
    definitions.push({
      key: 'textReplace',
      candidate: candidates.replace,
      operation: {
        op: 'text.replace', page: 0, target: candidates.replace.id,
        expect: { text }, value: text.at(-1) + text.slice(1, -1) + text[0],
      },
    });
  }
  if (candidates.path) definitions.push({
    key: 'pathStyle',
    candidate: candidates.path,
    operation: {
      op: 'path.style', page: 0, target: candidates.path.id,
      strokeWidthPt: candidates.path.strokeWidthPt * 1.2,
      stroke: '#336699',
    },
  });
  return definitions;
}

function candidateSummary(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    type: candidate.type,
    textSource: candidate.textSource,
    reusableCharacters: candidate.reusableCharacters,
    font: candidate.font,
    fontSizeYPt: candidate.fontSizeYPt,
    strokeWidthPt: candidate.strokeWidthPt,
    segmentCount: candidate.segmentCount,
    supportedOperations: candidate.supportedOperations,
  };
}

function validateReceipt(receipt) {
  const validation = receipt?.validation;
  if (!validation || !Object.hasOwn(validation, 'originalRawStreamsPreserved')) {
    throw Object.assign(new Error('Receipt is missing validation.originalRawStreamsPreserved'), { code: 'BENCHMARK_VALIDATION_FAILED' });
  }
  if (!Object.hasOwn(validation, 'rasterized') || validation.rasterized !== false) {
    throw Object.assign(new Error('Receipt must report validation.rasterized=false'), { code: 'BENCHMARK_VALIDATION_FAILED' });
  }
  if (!Array.isArray(validation.pixelGates) || validation.pixelGates.length === 0) {
    throw Object.assign(new Error('Receipt is missing validation.pixelGates'), { code: 'BENCHMARK_VALIDATION_FAILED' });
  }
  for (const gate of validation.pixelGates) {
    if (!Object.hasOwn(gate, 'changedPixelsOutside') || gate.changedPixelsOutside !== 0) {
      throw Object.assign(new Error(`Pixel gate changedPixelsOutside must be 0, received ${gate.changedPixelsOutside}`), { code: 'BENCHMARK_VALIDATION_FAILED' });
    }
  }
  return {
    originalRawStreamsPreserved: validation.originalRawStreamsPreserved,
    rasterized: validation.rasterized,
    pixelGates: validation.pixelGates.map(gate => ({
      page: gate.page,
      dpi: gate.dpi,
      changedPixelsInside: gate.changedPixelsInside,
      changedPixelsOutside: gate.changedPixelsOutside,
      maskedPixels: gate.maskedPixels,
    })),
  };
}

async function renderFirstExample(output, preview) {
  const edited = await openDocument(output);
  try { await edited.render({ page: 0, dpi: 144, output: preview }); }
  finally { await edited.close(); }
}

const files = await listPdfs(input);
const report = {
  version,
  createdAt: new Date().toISOString(),
  status: files.length ? 'running' : 'awaiting-samples',
  inputDirectory: input,
  outputDirectory: destination,
  environment: {
    os: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model,
    memoryGiB: os.totalmem() / 1024 ** 3, node: process.version,
  },
  protocol: {
    repetitions: runs,
    scope: 'Single-page real Figure PDFs only; multi-page papers are skipped.',
    mapping: 'inspect({page:0,limit:10000}) builds the verified source mapping; cached query reuses it.',
    selection: 'Short ASCII letter labels only; no numeric/statistical text is replaced. Replacement swaps first and last characters.',
    timing: 'Wall clock. Edit apply includes save, reopen verification, raw-stream checks and the 144 DPI pixel gate.',
    isolation: 'Every operation applies to the same opened original snapshot and publishes a unique output. Inputs are never overwritten.',
    cache: 'The OS file cache is not flushed. Cached query timings reuse the page mapping in the open editor.',
    percentile: 'Nearest-rank p95; small samples do not establish a performance guarantee.',
  },
  files: [],
  aggregates: {},
};

for (const [fileIndex, file] of files.entries()) {
  const fileDir = path.join(destination, String(fileIndex + 1).padStart(2, '0'));
  await mkdir(fileDir);
  const entry = {
    file,
    sourceSha256Before: null,
    sourceSha256After: null,
    originalUnchanged: null,
    pageCount: null,
    status: 'running',
    rejection: [],
    coverage: null,
    samples: { firstMapping: [], cachedQuery: [] },
    edits: Object.fromEntries(['textStyle', 'textReplace', 'pathStyle'].map(key => [key, {
      status: 'not-selected', candidate: null, operation: null, samples: [], attempts: [], example: null,
    }])),
  };
  let editor;
  try {
    entry.sourceSha256Before = await sha256(file);
    editor = await openDocument(file);
    report.engine ??= editor.engineInfo;
    entry.pageCount = editor.source.pageCount;
    entry.bytes = editor.source.bytes;
    if (editor.source.sha256 !== entry.sourceSha256Before) {
      throw Object.assign(new Error('openDocument source SHA-256 differs from the pre-open SHA-256'), { code: 'SOURCE_CHANGED_DURING_OPEN' });
    }
    if (entry.pageCount !== 1) {
      entry.status = 'skipped';
      entry.rejection.push({ phase: 'scope', code: 'MULTI_PAGE_SKIPPED', message: `Expected a single-page Figure; found ${entry.pageCount} pages` });
    } else {
      const inspection = await timed(() => editor.inspect({ page: 0, limit: 10000 }), entry.samples.firstMapping);
      const objects = inspection.objects ?? [];
      const supportedCounts = Object.fromEntries(['text.replace', 'text.style', 'path.style'].map(operation => [
        operation, objects.filter(object => supports(object, operation)).length,
      ]));
      const editable = objects.filter(object => object.editable === true).length;
      entry.coverage = {
        listedObjects: objects.length,
        editableObjects: editable,
        editableRatio: objects.length ? editable / objects.length : 0,
        supportedCounts,
        objectListTruncated: inspection.hasMore === true,
      };
      for (let run = 0; run < runs; run++) {
        await timed(() => editor.query({ page: 0, limit: 10000 }), entry.samples.cachedQuery);
      }

      const candidates = selectCandidates(objects);
      const definitions = operationDefinitions(candidates);
      const missing = [
        ['textStyle', candidates.style, 'NO_SAFE_TEXT_STYLE_CANDIDATE', 'No editable short letter label with a valid fontSizeYPt supports text.style'],
        ['textReplace', candidates.replace, 'NO_SAFE_TEXT_REPLACE_CANDIDATE', 'No editable short letter label can be swapped using verified reusable characters'],
        ['pathStyle', candidates.path, 'NO_SAFE_PATH_STYLE_CANDIDATE', 'No editable stroked path with positive width and at most 3 segments supports path.style'],
      ];
      for (const [key, candidate, code, message] of missing) if (!candidate) {
        entry.edits[key].status = 'skipped';
        entry.edits[key].rejection = { code, message };
        entry.rejection.push({ phase: 'selection', operation: key, code, message });
      }

      for (const definition of definitions) {
        const edit = entry.edits[definition.key];
        edit.status = 'running';
        edit.candidate = candidateSummary(definition.candidate);
        edit.operation = definition.operation;
        for (let run = 0; run < runs; run++) {
          const output = path.resolve(fileDir, `${definition.key}-${String(run + 1).padStart(2, '0')}.pdf`);
          const started = performance.now();
          try {
            const receipt = await editor.apply({
              sourceSha256: editor.source.sha256,
              operations: [definition.operation],
              output,
            });
            const elapsedMs = performance.now() - started;
            const validation = validateReceipt(receipt);
            edit.samples.push(elapsedMs);
            const attempt = { run: run + 1, status: 'passed', elapsedMs, output, outputSha256: receipt.outputSha256, validation };
            edit.attempts.push(attempt);
            if (!edit.example) {
              const preview = path.resolve(fileDir, `${definition.key}-example.png`);
              try {
                await renderFirstExample(output, preview);
                edit.example = { pdf: output, png: preview };
              } catch (error) {
                const rejection = { phase: 'example-render', operation: definition.key, run: run + 1, ...errorDetails(error) };
                entry.rejection.push(rejection);
                attempt.previewError = errorDetails(error);
              }
            }
          } catch (error) {
            const rejection = {
              phase: 'apply', operation: definition.key, run: run + 1,
              elapsedMs: performance.now() - started, ...errorDetails(error),
            };
            edit.attempts.push({ run: run + 1, status: 'rejected', output, ...rejection });
            entry.rejection.push(rejection);
            break; // Repeating the same rejected plan adds no performance evidence.
          }
        }
        edit.statistics = stats(edit.samples);
        edit.status = edit.samples.length === runs ? 'passed' : edit.samples.length ? 'partial' : 'rejected';
      }
      entry.status = entry.rejection.length ? 'completed-with-rejections' : 'passed';
    }
  } catch (error) {
    entry.status = 'failed';
    entry.rejection.push({ phase: 'file', ...errorDetails(error) });
  } finally {
    if (editor) {
      try { await editor.close(); }
      catch (error) { entry.rejection.push({ phase: 'close', ...errorDetails(error) }); entry.status = 'failed'; }
    }
    if (entry.sourceSha256Before) {
      try {
        entry.sourceSha256After = await sha256(file);
        entry.originalUnchanged = entry.sourceSha256After === entry.sourceSha256Before;
        if (!entry.originalUnchanged) {
          entry.status = 'failed';
          entry.rejection.push({ phase: 'source-integrity', code: 'SOURCE_CHANGED', message: 'Input SHA-256 changed during the benchmark' });
        }
      } catch (error) {
        entry.status = 'failed';
        entry.rejection.push({ phase: 'source-integrity', ...errorDetails(error) });
      }
    }
  }
  entry.statistics = {
    firstMapping: stats(entry.samples.firstMapping),
    cachedQuery: stats(entry.samples.cachedQuery),
  };
  report.files.push(entry);
  await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    file: path.basename(file), status: entry.status, pages: entry.pageCount,
    coverage: entry.coverage, rejections: entry.rejection.length, originalUnchanged: entry.originalUnchanged,
  }));
}

for (const key of ['firstMapping', 'cachedQuery']) {
  report.aggregates[key] = stats(report.files.flatMap(file => file.samples[key]));
}
for (const key of ['textStyle', 'textReplace', 'pathStyle']) {
  report.aggregates[key] = stats(report.files.flatMap(file => file.edits[key].samples));
}
if (files.length) {
  report.status = report.files.some(file => file.status !== 'skipped' && (file.status === 'failed' || file.rejection.length))
    ? 'failed'
    : report.files.some(file => file.status === 'skipped')
      ? 'passed-with-skips'
      : 'passed';
}
await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2));

const lines = [
  `# Real PDF object-edit benchmark: ${version}`,
  '',
  `Status: ${report.status}. PDFs: ${files.length}. Repetitions: ${runs}.`,
  '',
  'Only single-page Figures are measured. Multi-page papers are recorded as skipped. Every edit starts from the same original snapshot and writes a separate PDF.',
  '',
  '| Measurement | n | Median ms | p95 ms |',
  '|---|---:|---:|---:|',
];
for (const [key, summary] of Object.entries(report.aggregates)) if (summary) {
  lines.push(`| ${key} | ${summary.n} | ${summary.medianMs.toFixed(2)} | ${summary.p95Ms.toFixed(2)} |`);
}
lines.push(
  '',
  'Apply timings include output save, reopen validation, original-stream preservation checks, and the 144 DPI pixel gate. Only successful, fully validated applies contribute to edit timing statistics.',
  '',
  '| Input | Pages | Editable coverage | Status | Rejections | Source SHA before | Source SHA after |',
  '|---|---:|---:|---|---:|---|---|',
);
for (const entry of report.files) {
  const coverage = entry.coverage ? `${entry.coverage.editableObjects}/${entry.coverage.listedObjects} (${(entry.coverage.editableRatio * 100).toFixed(1)}%)` : 'n/a';
  lines.push(`| ${path.basename(entry.file).replaceAll('|', '\\|')} | ${entry.pageCount ?? 'n/a'} | ${coverage} | ${entry.status} | ${entry.rejection.length} | ${entry.sourceSha256Before ?? 'n/a'} | ${entry.sourceSha256After ?? 'n/a'} |`);
}
for (const entry of report.files.filter(file => file.rejection.length)) {
  lines.push('', `## Rejections: ${path.basename(entry.file)}`, '');
  for (const rejection of entry.rejection) {
    const where = [rejection.phase, rejection.operation, rejection.run ? `run ${rejection.run}` : null].filter(Boolean).join('/');
    lines.push(`- ${where}: ${rejection.code} — ${rejection.message}`);
  }
}
lines.push(
  '',
  'The first successful output for each edit type is rendered at 144 DPI beside its PDF for visual inspection. Later per-run PDFs are retained. The OS file cache is not flushed; p95 uses nearest rank.',
);
await writeFile(path.join(destination, 'report.md'), lines.join('\n') + '\n');
console.log(JSON.stringify({ report: path.join(destination, 'report.json'), status: report.status, aggregates: report.aggregates }, null, 2));
if (report.status === 'failed') process.exitCode = 1;
