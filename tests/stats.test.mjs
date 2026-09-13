import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfEditor, openDocument } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/stats-'));
const cli = args => spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), ...args], { encoding: 'utf8', windowsHide: true });

test('stats reports recursive page counts and rejects every unsupported parameter', async () => {
  const file = path.join(work, 'stats-source.pdf');
  await fixture(file);

  const unopened = await PdfEditor.create();
  try { await assert.rejects(unopened.stats(), { code: 'NO_DOCUMENT' }); }
  finally { await unopened.close(); }

  const editor = await openDocument(file);
  try {
    const first = await editor.stats();
    assert.deepEqual(first.counts, { form: 2, image: 2, path: 1, text: 3 });
    assert.equal(first.totalObjects, 8);
    assert.equal(first.pdfVersion, '1.7');
    assert.equal(first.source.file, path.resolve(file));
    assert.equal(first.source.pageCount, 4);
    assert.ok(first.capabilities.includes('stats'));
    const repeated = await editor.stats();
    assert.deepEqual(repeated.counts, first.counts);
    assert.equal(repeated.totalObjects, first.totalObjects);

    const rotated = await editor.stats({ page: 1 });
    assert.equal(rotated.userUnit, 2);
    assert.equal(rotated.rotation, 90);
    assert.equal(rotated.widthPt, 240);
    assert.equal(rotated.heightPt, 440);

    const inspected = await editor.inspect({ page: 0, limit: 100 });
    // Reader extraction may add a trailing layout space to a nested label.
    assert.deepEqual(inspected.objects.filter(object => object.type === 'text').map(object => object.text.trimEnd()), ['Panel A', 'Nested', 'Nested']);
    for (const key of ['text', 'type', 'limit', 'offset']) {
      await assert.rejects(editor.stats({ [key]: key === 'limit' || key === 'offset' ? 1 : 'text' }), { code: 'INVALID_ARGUMENT' });
    }
    await assert.rejects(editor.stats({ page: 4 }), { code: 'PAGE_NOT_FOUND' });
  } finally { await editor.close(); }

  const ok = cli(['stats', file, '--page', '1']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).totalObjects, 8);
  const invalid = cli(['stats', file, '--text', 'Nested']);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_ARGUMENT');
});
