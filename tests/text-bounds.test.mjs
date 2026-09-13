import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256 } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/text-bounds-'));
const content = 'q\n.75 w 30 40 m 190 40 l S\n'
  + 'BT /F1 12 Tf 1 0 0 1 30 115 Tm (Panel A) Tj ET\n'
  + 'BT /F1 12 Tf 1 0 0 1 30 95 Tm (Panel B) Tj ET\n';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < .0002, `${actual} != ${expected}`);

test('textBounds accepts text replacement and style using reopened rotated UserUnit geometry and physical tolerance', async () => {
  const file = path.join(work, 'rotated.pdf'); await fixture(file, { content });
  const editor = await openDocument(file);
  try {
    const plain = await editor.inspect({ page: 0, limit: 100 });
    const rotated = await editor.inspect({ page: 1, limit: 100 });
    const texts = ['Panel A', 'Panel B'].map(text => rotated.objects.find(o => o.textSource === text));
    for (const item of texts) {
      const a = plain.objects.find(o => o.textSource === item.textSource).boundsPt, b = item.boundsPt;
      // CropBox is 220 x 120 units. Page 1 rotates 90 degrees and uses UserUnit 2.
      near(b.x, (120 - a.y - a.height) * 2); near(b.y, a.x * 2);
      near(b.width, a.height * 2); near(b.height, a.width * 2);
    }
    const operations = texts.map((item, i) => ({
      op: i === 0 ? 'text.replace' : 'text.style', page: 1, target: item.id,
      expect: { text: item.textSource }, ...(i === 0 ? { value: item.textSource } : {}), fill: '#123456',
    }));
    const receipt = await editor.apply({ sourceSha256: editor.source.sha256, output: path.join(work, 'rotated-guarded.pdf'), operations,
      textBounds: texts.map(item => ({ page: 1, targets: [item.id], withinRectPt: {
        x: item.boundsPt.x + .0001, y: item.boundsPt.y + .0001,
        width: item.boundsPt.width - .0002, height: item.boundsPt.height - .0002,
      } })),
    });
    assert.deepEqual(receipt.validation.textBounds, { checkedObjects: 2, tolerancePt: .0002 });
    assert.equal(receipt.validation.pixelGates.length, 1);
    assert.equal(receipt.validation.pixelGates[0].changedPixelsOutside, 0);
    for (const item of texts) assert.deepEqual(receipt.changes.find(change => change.target === item.id).after.boundsPt, item.boundsPt);
    await assert.rejects(editor.apply({ sourceSha256: editor.source.sha256, output: path.join(work, 'outside-tolerance.pdf'), operations,
      textBounds: [{ page: 1, targets: [texts[0].id], withinRectPt: { ...texts[0].boundsPt, width: texts[0].boundsPt.width - .001 } }],
    }), error => {
      assert.equal(error.code, 'TEXT_OUTSIDE_BOUNDS'); assert.equal(error.details.issues.length, 1);
      near(error.details.issues[0].overflowPt.right, .001);
      return true;
    });
    await assert.rejects(access(path.join(work, 'outside-tolerance.pdf')), { code: 'ENOENT' });
    const unguarded = await editor.apply({ sourceSha256: editor.source.sha256, output: path.join(work, 'rotated-unguarded.pdf'), operations });
    assert.equal(Object.hasOwn(unguarded.validation, 'textBounds'), false);
  } finally { await editor.close(); }
});

test('textBounds aggregates two overflows through API and CLI, rejects invalid associations and leaves source and output intact', async () => {
  const directory = await mkdtemp(path.join(work, 'failures-'));
  const file = path.join(directory, 'source.pdf'); await fixture(file, { content });
  const hash = await sha256(file), editor = await openDocument(file);
  const output = path.join(directory, 'must-not-exist.pdf');
  try {
    const info = await editor.inspect({ page: 0, limit: 100 });
    const texts = ['Panel A', 'Panel B'].map(text => info.objects.find(o => o.textSource === text));
    const operations = texts.map(item => ({ op: 'text.replace', page: 0, target: item.id, expect: { text: item.textSource }, value: 'A'.repeat(20) }));
    // A has a smaller left bearing than P; allow 2 pt there while retaining the original right limit + 1 pt.
    const textBounds = texts.map(item => ({ page: 0, targets: [item.id], withinRectPt: { ...item.boundsPt, x: item.boundsPt.x - 2, width: item.boundsPt.width + 3 } }));
    const plan = { sourceSha256: hash, output, operations, textBounds };
    let details;
    await assert.rejects(editor.apply(plan), error => {
      assert.equal(error.code, 'TEXT_OUTSIDE_BOUNDS'); details = error.details;
      assert.equal(details.tolerancePt, .0002); assert.equal(details.issues.length, 2);
      assert.deepEqual(new Set(details.issues.map(issue => issue.target)), new Set(texts.map(item => item.id)));
      for (const issue of details.issues) {
        assert.equal(issue.page, 0); assert.equal(issue.code, 'TEXT_OUTSIDE_BOUNDS');
        assert.ok(issue.overflowPt.right > 100); assert.equal(issue.overflowPt.left, 0);
        near(issue.overflowPt.right, issue.boundsPt.x + issue.boundsPt.width - issue.withinRectPt.x - issue.withinRectPt.width);
      }
      return true;
    });
    const group = textBounds[0], line = info.objects.find(o => o.type === 'path');
    for (const invalid of [null, [], Array(101).fill(group), [{ ...group, extra: true }], [{ ...group, targets: [] }],
      [{ ...group, targets: [7] }], [{ ...group, targets: [texts[0].id, texts[0].id] }], [group, group],
      [{ ...group, page: 1 }], [{ ...group, targets: ['p0/99999'] }], [{ ...group, targets: [line.id] }],
      [{ ...group, targets: [info.objects.find(o => o.depth === 1 && o.type === 'text').id] }],
      [{ ...group, withinRectPt: { ...group.withinRectPt, width: 0 } }],
      [{ ...group, withinRectPt: { ...group.withinRectPt, extra: true } }],
    ]) await assert.rejects(editor.apply({ ...plan, textBounds: invalid }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(editor.apply({ ...plan, operations: [operations[0]], textBounds: [textBounds[1]] }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(editor.apply({ ...plan, operations: [{ op: 'path.style', page: 0, target: line.id, stroke: '#123456' }],
      textBounds: [{ ...group, targets: [line.id] }] }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(editor.apply({ ...plan, operations: [{ op: 'page.crop', page: 0, rectPt: { x: 0, y: 0, width: 200, height: 100 } }] }), { code: 'INVALID_ARGUMENT' });
    const planFile = path.join(directory, 'plan.json'); await writeFile(planFile, JSON.stringify(plan));
    const cli = spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), 'apply', file, planFile], { encoding: 'utf8', windowsHide: true });
    assert.equal(cli.status, 1, cli.stderr);
    const failure = JSON.parse(cli.stderr).error;
    assert.equal(failure.code, 'TEXT_OUTSIDE_BOUNDS'); assert.deepEqual(failure.details, details);
    await assert.rejects(access(output), { code: 'ENOENT' });
    assert.equal(await sha256(file), hash);
    assert.deepEqual((await readdir(directory)).sort(), ['plan.json', 'source.pdf']);
  } finally { await editor.close(); }
});
