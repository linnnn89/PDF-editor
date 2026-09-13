import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDocument, planTextReplacements, sha256, summarizeReceipt, version } from '../src/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    minMs: sorted[0], maxMs: sorted.at(-1) };
}

// The optional opener lets local comparisons use a separately built version.
// Plans, input text and complete receipts remain inside the local report directory.
export async function runBatchBenchmark({ input, replacements, destination, page = 0, runs = 5,
  open = openDocument, label = version }) {
  assert.ok(Number.isInteger(page) && page >= 0, 'page must be a nonnegative integer');
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 30, 'runs must be an integer from 1 to 30');
  assert.ok(Array.isArray(replacements) && replacements.length >= 1 && replacements.length <= 100,
    'Provide 1 to 100 explicit {from,to} replacements');
  assert.ok(replacements.every(item => item?.from !== item?.to), 'Each replacement must change its source text');
  await mkdir(destination, { recursive: true });
  const sourceHash = await sha256(input);
  const started = performance.now();
  const editor = await open(input);
  const openMs = performance.now() - started;
  try {
    const queryStart = performance.now();
    const query = await editor.query({ page, type: 'text', limit: 10000,
      fields: ['textSource', 'editable', 'supportedOperations'] });
    const firstQueryMs = performance.now() - queryStart;
    // Validate the entire mapping before generating any benchmark output.
    const complete = planTextReplacements(query, replacements);
    const counts = [...new Set([1, Math.ceil(replacements.length / 2), replacements.length])];
    const report = { version: label, input: path.resolve(input), page, sourceSha256: sourceHash, runs,
      openMs, firstQueryMs, queryBytes: bytes(query),
      protocol: {
        scope: 'Explicit whole-label replacements on one page; no automatic study detection.',
        timing: 'Each batch uses the same immutable source snapshot. One untimed apply warms each batch size; measured applies include save, reopen, integrity and pixel gates. Rendering and report I/O are outside apply timing.',
        cache: 'One session per version; OS cache is not flushed. First query includes mapping.',
        payload: 'JSON UTF-8 byte counts, not model token counts. Reasoning/network latency is excluded.',
      }, batches: [] };
    for (const count of counts) {
      const items = replacements.slice(0, count);
      const planningStart = performance.now();
      const plan = planTextReplacements(query, items);
      const planningMs = performance.now() - planningStart;
      const samples = [], nativeSamples = [];
      let example;
      for (let run = -1; run < runs; run++) {
        const name = `batch-${count}-${run < 0 ? 'warmup' : run + 1}`;
        const output = path.resolve(destination, `${name}.pdf`);
        const start = performance.now();
        const receipt = await editor.apply({ ...plan, output });
        const elapsed = performance.now() - start;
        assert.equal(receipt.changes.length, count);
        assert.equal(receipt.validation.rasterized, false);
        assert.ok(receipt.validation.pixelGates.length > 0);
        assert.ok(receipt.validation.pixelGates.every(gate => gate.changedPixelsOutside === 0));
        const actual = new Map(receipt.changes.map(change => [change.target, change.after.textSource]));
        for (const operation of plan.operations) assert.equal(actual.get(operation.target), operation.value);
        if (run >= 0) { samples.push(elapsed); nativeSamples.push(receipt.engineMs); }
        await writeFile(path.join(destination, `${name}.receipt.json`), json(receipt));
        if (run === 0) example = receipt;
      }
      const preview = path.resolve(destination, `batch-${count}.png`);
      const saved = await open(example.output);
      try {
        await saved.render({ page, dpi: 144, output: preview });
        const after = await saved.query({ page, type: 'text', limit: 10000,
          fields: ['textSource', 'editable', 'supportedOperations'] });
        for (const operation of plan.operations) {
          assert.equal(after.objects.find(object => object.id === operation.target)?.textSource, operation.value);
        }
      } finally { await saved.close(); }
      report.batches.push({ count, planningMs, apply: statistics(samples), native: statistics(nativeSamples),
        replacementBytes: bytes(items), operationsBytes: bytes(plan.operations),
        fullReceiptBytes: bytes(example), summaryReceiptBytes: bytes(summarizeReceipt(example)),
        output: example.output, preview, validation: summarizeReceipt(example).validation });
    }
    assert.equal(complete.operations.length, replacements.length);
    report.sourceUnchanged = (await sha256(input)) === sourceHash;
    assert.ok(report.sourceUnchanged);
    await writeFile(path.join(destination, 'report.json'), json(report));
    return report;
  } finally { await editor.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, replacements: { type: 'string' },
    page: { type: 'string', default: '0' }, runs: { type: 'string', default: '5' } } });
  if (!values.input || !values.replacements) throw new Error('Usage: node scripts/benchmark-batch.mjs --input figure.pdf --replacements names.json [--page 0] [--runs 5]');
  const parent = path.join(root, 'artifacts/benchmarks-batch');
  await mkdir(parent, { recursive: true });
  const destination = await mkdtemp(path.join(parent, 'run-'));
  const report = await runBatchBenchmark({ input: path.resolve(values.input),
    replacements: JSON.parse(await readFile(values.replacements, 'utf8')), destination,
    page: Number(values.page), runs: Number(values.runs) });
  console.log(JSON.stringify({ report: path.join(destination, 'report.json'), sourceUnchanged: report.sourceUnchanged,
    batches: report.batches.map(({ count, apply }) => ({ count, ...apply })) }, null, 2));
}
