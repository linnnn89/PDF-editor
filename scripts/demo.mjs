import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256 } from '../src/index.mjs';
import { fixture } from '../tests/fixtures.mjs';

// Generate a synthetic PDF locally; no research PDF or font file is distributed.
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'output'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'output/demo-'));
const input = path.join(directory, 'before.pdf');
await fixture(input, {
  content: 'q\n0.4 0.4 0.4 RG 0.75 w 30 95 m 190 95 l S\nBT /F1 12 Tf 1 0 0 1 30 115 Tm (Panle A) Tj ET\n',
});
const originalHash = await sha256(input);
const editor = await openDocument(input);
let receipt;
try {
  const page = await editor.inspect({ page: 0, limit: 100 });
  const label = page.objects.find(object => object.editable && object.textSource === 'Panle A');
  const line = page.objects.find(object => object.type === 'path' && object.editable);
  assert.ok(label && line, 'The generated label and line must be editable');
  await editor.render({ page: 0, dpi: 216, output: path.join(directory, 'before.png') });
  receipt = await editor.apply({
    sourceSha256: page.source.sha256,
    output: path.join(directory, 'after.pdf'),
    operations: [
      { op: 'text.replace', page: 0, target: label.id, expect: { text: label.textSource },
        value: 'Panel A', fontSizePt: 18, fill: '#1D4ED8' },
      { op: 'path.style', page: 0, target: line.id, strokeWidthPt: 1.5, stroke: '#1D4ED8' },
    ],
  });
  assert.equal(receipt.validation.pixelGates[0].changedPixelsOutside, 0);
  await editor.open(receipt.output);
  const after = await editor.inspect({ page: 0, limit: 100 });
  assert.equal(after.objects.find(object => object.id === label.id).textSource, 'Panel A');
  await editor.render({ page: 0, dpi: 216, output: path.join(directory, 'after.png') });
} finally {
  await editor.close();
}
assert.equal(await sha256(input), originalHash);
await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({
  directory, input, output: receipt.output,
  beforePreview: path.join(directory, 'before.png'),
  afterPreview: path.join(directory, 'after.png'),
  originalUnchanged: true,
  changedPixelsOutside: receipt.validation.pixelGates[0].changedPixelsOutside,
}, null, 2));
