import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256, version } from '../src/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runFile = promisify(execFile);
const { values } = parseArgs({ options: { dir: { type: 'string' }, runs: { type: 'string', default: '10' } } });
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error('--runs must be an integer from 1 to 100');
const input = path.resolve(values.dir ?? path.join(root, 'test pdf'));
const destination = path.join(root, 'artifacts', 'benchmarks', new Date().toISOString().replaceAll(':', '-'));
await mkdir(input, { recursive: true }); await mkdir(destination, { recursive: true });
async function list(dir) {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory()) result.push(...await list(path.join(dir, item.name)));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) result.push(path.join(dir, item.name));
  }
  return result.sort();
}
function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, medianMs: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2,
    p95Ms: sorted[Math.ceil(sorted.length * .95)-1], minMs: sorted[0], maxMs: sorted.at(-1) };
}
async function timed(action, samples) {
  const start = performance.now(); const result = await action();
  samples.push(performance.now() - start); return result;
}
const files = await list(input);
const report = {
  version, createdAt: new Date().toISOString(), status: files.length ? 'running' : 'awaiting-samples',
  environment: { os: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, memoryGiB: os.totalmem() / 1024 ** 3, node: process.version },
  protocol: { repetitions: runs, pageIndices: 'zero-based', crop: 'inset each page by 1 pt; original content streams preserved',
    compose: 'two full-size copies of page 0 with a 16 pt gap; single-page figures only', renderDpi: 144,
    timing: 'wall clock including JS RPC, source checks, output publication and native validation; excludes model inference',
    cache: 'OS file cache is not flushed; cold CLI starts a new process; warm query reuses the parsed page',
    validation: 'crop: reopen and exact SHA-256 multiset of raw streams; compose: reopen and Form count; raster difference not an automatic runtime gate',
    percentile: 'nearest-rank p95; small samples do not establish a performance guarantee' },
  files: [], aggregates: {},
};
for (const file of files) {
  const entry = { file, sourceSha256: await sha256(file), pages: [], samples: { coldOpen: [], coldIndexAllPages: [], coldCliInspect: [], warmQuery: [], crop: [], render: [], compose: [] } };
  let editor;
  const fileDir = path.join(destination, String(report.files.length + 1).padStart(2, '0'));
  await mkdir(fileDir);
  try {
    editor = await timed(() => openDocument(file), entry.samples.coldOpen);
    report.engine = editor.engineInfo;
    entry.bytes = editor.source.bytes;
    await timed(async () => {
      for (let page = 0; page < editor.source.pageCount; page++) {
        const info = await editor.inspect({ page, limit: 10000 });
        entry.pages.push({ page, widthPt: info.widthPt, heightPt: info.heightPt, rotation: info.rotation, counts: info.counts, warnings: info.warnings,
          fonts: [...new Set(info.objects.filter(o => o.font).map(o => o.font))], objectListTruncated: info.hasMore });
      }
    }, entry.samples.coldIndexAllPages);
    await timed(() => runFile(process.execPath, [path.join(root, 'src/cli.mjs'), 'inspect', file, '--limit', '0'], { windowsHide: true, maxBuffer: 1024 * 1024 }), entry.samples.coldCliInspect);
    for (let i = 0; i < runs; i++) {
      await timed(() => editor.query({ page: 0, type: 'text', limit: 20 }), entry.samples.warmQuery);
      entry.lastCrop = await timed(() => editor.apply({ sourceSha256: entry.sourceSha256, requestId: `bench-${i}`, output: path.join(fileDir, `crop-${i}.pdf`),
        operations: entry.pages.map(p => ({ op: 'page.crop', page: p.page, rectPt: { x: 1, y: 1, width: p.widthPt - 2, height: p.heightPt - 2 } })) }), entry.samples.crop);
      await timed(() => editor.render({ page: 0, dpi: 144, output: path.join(fileDir, `preview-${i}.png`) }), entry.samples.render);
      if (entry.pages.length === 1) {
        const p = entry.pages[0];
        entry.lastCompose = await timed(() => editor.compose({ widthPt: p.widthPt * 2 + 16, heightPt: p.heightPt, output: path.join(fileDir, `compose-${i}.pdf`), panels: [
          { file, sourceSha256: entry.sourceSha256, page: 0, targetRectPt: { x: 0, y: 0, width: p.widthPt, height: p.heightPt } },
          { file, sourceSha256: entry.sourceSha256, page: 0, targetRectPt: { x: p.widthPt + 16, y: 0, width: p.widthPt, height: p.heightPt } },
        ] }), entry.samples.compose);
      }
    }
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = { code: error.code, message: error.message }; }
  finally { if (editor) await editor.close(); }
  entry.originalUnchanged = await sha256(file) === entry.sourceSha256;
  if (!entry.originalUnchanged) entry.status = 'failed';
  entry.statistics = Object.fromEntries(Object.entries(entry.samples).map(([key, samples]) => [key, stats(samples)]));
  report.files.push(entry);
  console.log(JSON.stringify({ file: path.basename(file), status: entry.status, pages: entry.pages.length, originalUnchanged: entry.originalUnchanged, error: entry.error }));
  await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2));
}
for (const key of ['coldOpen', 'coldIndexAllPages', 'coldCliInspect', 'warmQuery', 'crop', 'render', 'compose']) {
  report.aggregates[key] = stats(report.files.flatMap(file => file.samples[key]));
}
if (files.length) report.status = report.files.every(file => file.status === 'passed') ? 'passed' : 'failed';
await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2));
const lines = [`# Real PDF benchmark: ${version}`, '', `Status: ${report.status}. Files: ${files.length}. Repetitions: ${runs}.`, '',
  'Original PDFs are read-only. Performance outputs use a 1 pt inset for exercising the crop operation, not a recommended publication crop.', '',
  '| Operation | n | Median ms | p95 ms |', '|---|---:|---:|---:|'];
for (const [key, summary] of Object.entries(report.aggregates)) if (summary) lines.push(`| ${key} | ${summary.n} | ${summary.medianMs.toFixed(2)} | ${summary.p95Ms.toFixed(2)} |`);
lines.push('', 'The OS file cache was not flushed. Cold CLI includes process startup; warm query reuses parsed pages. All timings exclude model inference.', '',
  'Runtime verification covers crop raw-stream hashes, saved page boxes, reopened PDFs and composition Form objects. Pixel comparison is separate from this benchmark.', '',
  '| Input | Pages | Status | Original SHA-256 unchanged |', '|---|---:|---|---|');
for (const entry of report.files) lines.push(`| ${path.basename(entry.file).replaceAll('|', '\\|')} | ${entry.pages.length} | ${entry.status} | ${entry.originalUnchanged} |`);
await writeFile(path.join(destination, 'report.md'), lines.join('\n') + '\n');
console.log(JSON.stringify({ report: path.join(destination, 'report.json'), status: report.status, aggregates: report.aggregates }, null, 2));
if (report.status === 'failed') process.exitCode = 1;
