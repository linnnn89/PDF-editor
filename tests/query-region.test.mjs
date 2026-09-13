import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDocument } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

test('geometric region queries isolate duplicate labels before projection and pagination and survive editing', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
  const work = await mkdtemp(path.join(root, 'artifacts/tests/query-region-'));
  const input = path.join(work, 'source.pdf');
  await fixture(input, { content: 'q\n0 0 0 rg 30 40 20 10 re f\nBT /F1 12 Tf 1 0 0 1 30 115 Tm (Panel A) Tj ET\nBT /F1 12 Tf 1 0 0 1 130 115 Tm (Panel A) Tj ET\n' });
  const region = { x: 10, y: 5, width: 80, height: 35 };
  const editor = await openDocument(input);
  try {
    const unmapped = await editor.query({ text: 'Panel A', withinRectPt: region, mapping: false, fields: ['text'] });
    assert.equal(unmapped.matched, 1);
    assert.equal(unmapped.objects[0].id, 'p0/1');
    assert.deepEqual(Object.keys(unmapped.objects[0]).sort(), ['id', 'text', 'type']);
    const all = await editor.inspect({ limit: 100 });
    assert.deepEqual(all.counts, { form: 2, image: 2, path: 1, text: 4 });
    assert.equal(all.matched, 9);
    const defaults = await editor.query({ text: 'Panel A' });
    assert.equal(defaults.matched, 2);
    assert.ok(defaults.objects[0].matrix);
    const selected = await editor.query({ text: 'Panel A', withinRectPt: region, fields: ['textSource', 'editable', 'supportedOperations'] });
    assert.equal(selected.matched, 1);
    assert.deepEqual(selected.counts, all.counts);
    assert.equal(selected.hasMore, false);
    assert.equal(selected.objects[0].boundsPt, undefined);
    const paged = await editor.query({ type: 'text', withinRectPt: { x: 0, y: 0, width: 220, height: 40 }, offset: 1, limit: 1, fields: [] });
    assert.equal(paged.matched, 2);
    assert.equal(paged.offset, 1);
    assert.equal(paged.hasMore, false);
    assert.deepEqual(paged.objects, [{ id: 'p0/2', type: 'text' }]);
    const zero = await editor.query({ withinRectPt: region, limit: 0 });
    assert.equal(zero.matched, 1); assert.equal(zero.hasMore, true); assert.deepEqual(zero.objects, []);
    const partial = await editor.query({ text: 'Panel A', withinRectPt: { x: 20, y: 5, width: 5, height: 35 } });
    assert.equal(partial.matched, 0);
    const pathBounds = { x: 20, y: 90, width: 20, height: 10 };
    assert.equal((await editor.query({ type: 'path', withinRectPt: pathBounds })).matched, 1);
    assert.equal((await editor.query({ type: 'path', withinRectPt: { ...pathBounds, x: 20.0001 } })).matched, 1);
    assert.equal((await editor.query({ type: 'path', withinRectPt: { ...pathBounds, x: 20.001 } })).matched, 0);
    const whole = await editor.inspect({ withinRectPt: { x: 0, y: 0, width: 220, height: 120 }, mapping: false });
    assert.deepEqual(whole.objects.map(item => item.id), all.objects.map(item => item.id));

    // These boxes are the same source rectangle [20,100,100,135], transformed
    // independently using the fixture's CropBox, page rotation and UserUnit.
    const regions = [region, { x: 160, y: 20, width: 70, height: 160 },
      { x: 130, y: 80, width: 80, height: 35 }, { x: 5, y: 130, width: 35, height: 80 }];
    for (let page = 0; page < 4; page++) {
      const rotated = await editor.query({ page, text: 'Panel A', withinRectPt: regions[page] });
      assert.equal(rotated.coordinateSystem, 'rotated-visible-page-top-left-pt');
      assert.equal(rotated.rotation, page * 90);
      assert.equal(rotated.userUnit, page === 1 ? 2 : 1);
      assert.equal(rotated.matched, 1);
      assert.equal(rotated.objects[0].id, `p${page}/1`);
    }
    for (const withinRectPt of [null, [], {}, { ...region, width: 0 }, { ...region, height: -1 },
      { ...region, x: '10' }, { ...region, x: NaN }, { ...region, width: Infinity },
      { ...region, extra: 1 }, { x: 1e308, y: 0, width: 1e308, height: 1 }]) {
      await assert.rejects(editor.query({ withinRectPt }), { code: 'INVALID_ARGUMENT' });
    }
    for (const withinRectPt of [{ ...region, x: -1 }, { ...region, width: 300 }]) {
      await assert.rejects(editor.inspect({ withinRectPt }), { code: 'OUTSIDE_PAGE' });
    }
    const target = selected.objects[0];
    const receipt = await editor.apply({ sourceSha256: selected.source.sha256, output: path.join(work, 'edited.pdf'), operations: [
      { op: 'text.replace', page: 0, target: target.id, expect: { text: target.textSource }, value: 'A Panel' },
    ] });
    assert.ok(receipt.validation.reopened);
    assert.equal(receipt.changes.length, 1);
    assert.equal(receipt.validation.pixelGates[0].changedPixelsOutside, 0);
    await editor.open(receipt.output);
    assert.equal((await editor.query({ id: target.id })).objects[0].textSource, 'A Panel');
    assert.equal((await editor.query({ id: 'p0/2' })).objects[0].textSource, 'Panel A');
  } finally { await editor.close(); }

  const cli = args => spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
  for (const command of ['inspect', 'query']) {
    const result = cli([command, input, '--text', 'Panel A', '--within-rect', '10, 5,80,35', '--fields', 'text']);
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.matched, 1); assert.equal(response.objects[0].id, 'p0/1');
  }
  for (const rectangle of ['', '0,,10,10', '0,0,10', '0,0,10,10,1', '0,0,Infinity,10', '0,0,NaN,10', '0,0, ,10']) {
    const invalid = cli(['query', input, '--within-rect', rectangle]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_ARGUMENT');
  }
  for (const command of ['stats', 'render', 'apply', 'compose', 'doctor']) {
    const invalid = cli([command, input, '--within-rect', '0,0,10,10']);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_ARGUMENT');
  }
});
