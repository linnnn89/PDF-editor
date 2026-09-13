import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256 } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/regressions-'));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < .0002, `${actual} != ${expected}`);
const missing = file => assert.rejects(access(file), { code: 'ENOENT' });
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Request did not settle'), { code: 'TEST_DEADLINE' })), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
function cropPlan(editor, name, width = 180) {
  return { sourceSha256: editor.source.sha256, requestId: name, output: path.join(work, `${name}.pdf`),
    operations: [{ op: 'page.crop', page: 0, rectPt: { x: 10, y: 10, width, height: 90 } }] };
}

test('pre-cancelled and queued cancellations settle without stopping an idle worker or publishing files', async () => {
  const file = path.join(work, 'cancel-source.pdf'); await fixture(file);
  const hash = await sha256(file), editor = await openDocument(file), pid = editor.engineInfo.pid;
  const options = { signal: AbortSignal.abort() };
  try {
    const plan = cropPlan(editor, 'pre-aborted');
    await assert.rejects(bounded(editor.apply(plan, options)), { code: 'CANCELLED' });
    await assert.rejects(bounded(editor.render({ output: path.join(work, 'pre-aborted.png') }, options)), { code: 'CANCELLED' });
    await assert.rejects(bounded(editor.compose({ widthPt: 220, heightPt: 120, output: path.join(work, 'pre-aborted-compose.pdf'),
      panels: [{ file, page: 0, targetRectPt: { x: 0, y: 0, width: 220, height: 120 } }] }, options)), { code: 'CANCELLED' });

    const inspection = editor.inspect({ mapping: false, limit: 1 });
    const controller = new AbortController();
    const queued = editor.render({ output: path.join(work, 'queued-cancel.png') }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(bounded(queued), { code: 'CANCELLED' });
    assert.equal((await inspection).pageCount, 4);
    assert.equal((await editor.inspect({ mapping: false, limit: 1 })).pageCount, 4);
    process.kill(pid, 0);
    for (const name of ['pre-aborted.pdf', 'pre-aborted.png', 'pre-aborted-compose.pdf', 'queued-cancel.png']) await missing(path.join(work, name));
    assert.equal((await readdir(work)).some(name => name.startsWith('.pdfedit-')), false);
    assert.equal(await sha256(file), hash);
  } finally { await editor.close(); }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('queued apply/compose use input snapshots and replay cannot be changed through returned receipts', async () => {
  const file = path.join(work, 'snapshot-source.pdf'); await fixture(file);
  const editor = await openDocument(file);
  try {
    const plan = cropPlan(editor, 'snapshot'), submitted = structuredClone(plan);
    const pending = editor.apply(plan);
    await new Promise(resolve => setImmediate(resolve));
    plan.operations[0].rectPt.width = 140;
    const receipt = await pending;
    assert.equal(receipt.changes[0].rectPt.width, 180);
    const saved = await openDocument(receipt.output);
    try { assert.equal((await saved.inspect({ mapping: false, limit: 0 })).widthPt, 180); }
    finally { await saved.close(); }

    receipt.changes[0].rectPt.width = 99;
    const replay = await editor.apply(submitted);
    assert.equal(replay.replayed, true); assert.equal(replay.changes[0].rectPt.width, 180);
    replay.changes[0].rectPt.width = 77;
    assert.equal((await editor.apply(submitted)).changes[0].rectPt.width, 180);
    await assert.rejects(editor.apply(plan), { code: 'REQUEST_ID_CONFLICT' });

    const composition = { widthPt: 220, heightPt: 120, output: path.join(work, 'snapshot-compose.pdf'),
      panels: [{ file, page: 0, targetRectPt: { x: 0, y: 0, width: 220, height: 120 } }] };
    const composed = editor.compose(composition);
    composition.widthPt = 440; composition.panels[0].targetRectPt.width = 100;
    const result = await composed;
    assert.equal(result.placements[0].placedRectPt.width, 220);
    const check = await openDocument(result.output);
    try { assert.equal((await check.inspect({ mapping: false, limit: 0 })).widthPt, 220); }
    finally { await check.close(); }
  } finally { await editor.close(); }
});

test('leading TJ positioning survives replacement and resizing with empty strings, Tz, Rotate and UserUnit', async () => {
  for (const [name, prefix, adjustment, suffix, followingX] of [
    ['positive', '100', 100, '', 62.3712],
    ['mixed', '100 () -25', 75, '', 62.6112],
    // PDFium ignores terminal kerning in arrays containing an empty string.
    ['mixed-tail', '100 () -25', 75, '50 () -15', 62.6112],
    ['negative-tail', '-100', -100, '-40', 64.6752],
  ]) {
    const file = path.join(work, `${name}-tj.pdf`);
    await fixture(file, { content: `q\nBT /F1 12 Tf 80 Tz 1 0 0 1 30 115 Tm [${prefix} (Pan) 30 (el A) ${suffix}] TJ /Span BMC ( A) Tj EMC ET\n` });
    const hash = await sha256(file), editor = await openDocument(file);
    try {
      const before = [], operations = [];
      for (const page of [0, 1, 2]) {
        const info = await editor.inspect({ page, limit: 100 });
        const target = info.objects.find(o => o.textSource === 'Panel A');
        const following = info.objects.find(o => o.textSource === ' A');
        assert.equal(target.editable, true);
        const anchor = 30 - adjustment * 12 / 1000 * .8;
        near(target.matrix[4], anchor);
        near(following.matrix[4], followingX);
        before.push({ target, following });
        operations.push({ op: page === 1 ? 'text.style' : 'text.replace', page, target: target.id, expect: { text: target.textSource },
          ...(page === 1 ? { fontSizePt: 20 } : { value: 'Panel', ...(page === 2 ? { fontSizePt: 15 } : {}) }) });
      }
      const output = path.join(work, `${name}-tj-edited.pdf`);
      const receipt = await editor.apply({ sourceSha256: hash, output, operations });
      assert.ok(receipt.validation.pixelGates.every(gate => gate.changedPixelsOutside === 0));
      const after = await openDocument(output);
      try {
        for (const page of [0, 1, 2]) {
          const info = await after.inspect({ page, limit: 100 });
          const result = info.objects.find(o => o.id === before[page].target.id);
          assert.equal(result.textSource, page === 1 ? 'Panel A' : 'Panel');
          near(result.fontSizeYPt, [12, 20, 15][page]);
          for (const item of [before[page].target, before[page].following]) {
            const actual = info.objects.find(o => o.id === item.id);
            item.matrix.forEach((n,i) => near(actual.matrix[i], n));
          }
        }
        await after.render({ page: 0, output: path.join(work, `${name}-tj-edited.png`), dpi: 144 });
      } finally { await after.close(); }
      assert.equal(await sha256(file), hash);
    } finally { await editor.close(); }
  }
});
