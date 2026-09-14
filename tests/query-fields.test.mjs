import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDocument } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/query-fields-'));
const input = path.join(work, 'source.pdf');
await fixture(input);

test('projected queries retain selection, edit preconditions and the complete internal index', async () => {
  const editor = await openDocument(input);
  try {
    const result = await editor.query({ text: 'Panel A', editable: true, fields: ['textSource', 'editable', 'supportedOperations'] });
    assert.equal(result.matched, 1);
    assert.deepEqual(result.counts, { form: 2, image: 2, path: 1, text: 3 });
    const label = result.objects[0];
    assert.deepEqual(Object.keys(label).sort(), ['editable', 'id', 'supportedOperations', 'textSource', 'type']);
    assert.equal(label.id, 'p0/1'); assert.equal(label.textSource, 'Panel A');
    assert.ok(label.supportedOperations.includes('text.replace'));
    const paged = await editor.query({ type: 'text', offset: 1, limit: 1, fields: ['text'] });
    assert.equal(paged.matched, 3); assert.equal(paged.hasMore, true); assert.equal(paged.offset, 1);
    assert.equal(paged.objects[0].id, 'p0/2/0'); assert.equal(paged.objects[0].text.trimEnd(), 'Nested');
    const ids = await editor.inspect({ limit: 1, fields: [] });
    assert.deepEqual(ids.objects, [{ id: 'p0/0', type: 'path' }]);
    const full = await editor.query({ id: label.id });
    assert.ok(full.objects[0].matrix); assert.ok(full.objects[0].boundsPt); assert.equal(full.objects[0].textSource, 'Panel A');
    const receipt = await editor.apply({ sourceSha256: result.source.sha256, output: path.join(work, 'edited.pdf'), operations: [
      { op: 'text.replace', page: 0, target: label.id, expect: { text: label.textSource }, value: 'A Panel' },
    ] });
    assert.equal(receipt.validation.pixelGates[0].changedPixelsOutside, 0);
    assert.equal(receipt.validation.unchangedObjectsVerified, 7);
    await editor.open(receipt.output);
    const after = await editor.query({ id: label.id, fields: ['textSource', 'fontSizeYPt'] });
    assert.equal(after.objects[0].textSource, 'A Panel');
    assert.equal(after.objects[0].fontSizeYPt, 12);
  } finally { await editor.close(); }
});

test('field selection validates its contract and works through the CLI without changing defaults', async () => {
  const editor = await openDocument(input);
  try {
    for (const fields of ['text', null, ['unknown'], [4], Array(26).fill('text')]) {
      await assert.rejects(editor.query({ fields }), { code: 'INVALID_ARGUMENT' });
    }
    const missing = await editor.query({ type: 'image', fields: ['textSource'], mapping: false });
    assert.equal(missing.matched, 2);
    assert.ok(missing.objects.every(object => Object.keys(object).length === 2 && object.type === 'image'));
  } finally { await editor.close(); }
  const cli = args => spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
  const result = cli(['query', input, '--text', 'Panel A', '--fields', 'textSource, editable,supportedOperations']);
  assert.equal(result.status, 0, result.stderr);
  const projected = JSON.parse(result.stdout).objects[0];
  assert.equal(projected.textSource, 'Panel A'); assert.equal(projected.matrix, undefined); assert.equal(projected.editable, true);
  const full = cli(['query', input, '--text', 'Panel A']);
  assert.equal(full.status, 0, full.stderr); assert.ok(JSON.parse(full.stdout).objects[0].matrix);
  for (const args of [['query', input, '--fields', 'text,'], ['stats', input, '--fields', 'text']]) {
    const invalid = cli(args); assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_ARGUMENT');
  }
});
