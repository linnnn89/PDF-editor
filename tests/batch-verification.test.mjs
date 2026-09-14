import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256 } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/batch-verification-'));
const sourceObjects = info => info.objects.map(({ editable, sourceMapping, supportedOperations, editReason, editReasonCode, textSource, reusableCharacters, sourceCommand, strokeWidthPt, ...rest }) => rest);

test('batch glyph verification keeps each target distinct with real spaces and punctuation across reopened pages', async () => {
  const file = path.join(work, 'source.pdf');
  await fixture(file, { content: 'q\n.75 w 30 40 m 190 40 l S\n'
    + 'BT /F1 10 Tf 1 0 0 1 30 122 Tm (A, B!) Tj ET\n'
    + 'BT /F1 10 Tf 1 0 0 1 30 108 Tm (B: A.) Tj ET\n'
    + 'BT /F1 10 Tf 1 0 0 1 30 94 Tm (A-B?) Tj ET\n' });
  const hash = await sha256(file), editor = await openDocument(file);
  try {
    const before = [await editor.inspect({ page: 0, limit: 100 }), await editor.inspect({ page: 1, limit: 100 })];
    const untouched = await editor.inspect({ page: 2, mapping: false, limit: 100 });
    const replacements = [
      { page: 0, source: 'A, B!', value: 'B, A!' },
      { page: 0, source: 'B: A.', value: 'A: B.' },
      { page: 0, source: 'A-B?', value: 'B-A?' },
      { page: 1, source: 'A, B!', value: 'B, A!' },
    ];
    const operations = replacements.map(({ page, source, value }) => {
      const target = before[page].objects.find(o => o.textSource === source);
      assert.equal(target?.editable, true);
      return { op: 'text.replace', page, target: target.id, expect: { text: source }, value };
    });
    const output = path.join(work, 'edited.pdf');
    const receipt = await editor.apply({ sourceSha256: hash, output, operations });
    assert.equal(receipt.changes.length, operations.length);
    assert.equal(receipt.validation.reopened, true);
    assert.equal(receipt.validation.patchedContentsVerified, true);
    assert.equal(receipt.validation.unchangedObjectsVerified,
      before.reduce((count, info) => count + info.objects.length, 0) - operations.length);
    assert.deepEqual(receipt.validation.pixelGates.map(gate => gate.page), [0, 1]);
    for (const gate of receipt.validation.pixelGates) {
      assert.equal(gate.changedPixelsOutside, 0);
      assert.ok(gate.changedPixelsInside > 0);
    }
    const after = await openDocument(output);
    try {
      for (let page = 0; page < before.length; ++page) {
        const info = await after.inspect({ page, limit: 100 });
        assert.equal(info.objects.length, before[page].objects.length);
        const targets = new Set(operations.filter(op => op.page === page).map(op => op.target));
        for (const op of operations.filter(op => op.page === page)) {
          assert.equal(info.objects.find(o => o.id === op.target).textSource, op.value);
          assert.equal(receipt.changes.find(change => change.page === page && change.target === op.target).after.textSource, op.value);
        }
        assert.deepEqual(sourceObjects(info).filter(o => !targets.has(o.id)),
          sourceObjects(before[page]).filter(o => !targets.has(o.id)));
      }
      assert.deepEqual(sourceObjects(await after.inspect({ page: 2, mapping: false, limit: 100 })), sourceObjects(untouched));
    } finally { await after.close(); }
    assert.equal(await sha256(file), hash);
  } finally { await editor.close(); }
});
