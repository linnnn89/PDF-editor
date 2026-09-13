import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, composeFigure, sha256, doctor } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/run-'));
const qpdf = path.join(root, 'vendor/qpdf/qpdf-12.4.1-msvc64/bin/qpdf.exe');
function structure(file) {
  const data = JSON.parse(execFileSync(qpdf, ['--json', '--json-key=pages', '--json-key=qpdf', '--json-stream-data=none', file], { encoding: 'utf8', windowsHide: true }));
  return { pages: data.pages, objects: data.qpdf[1], object: ref => data.qpdf[1][`obj:${ref}`] };
}
async function missing(file) { await assert.rejects(access(file), { code: 'ENOENT' }); }
function noProcess(pid) { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); }

test('inspect and crop split content, repeated Forms, images, Rotate and UserUnit without changing source streams', async () => {
  const file = path.join(work, '中文 source.pdf'); await fixture(file);
  const hash = await sha256(file); const editor = await openDocument(file);
  const pid = editor.engineInfo.pid;
  try {
    const info = await editor.inspect({ limit: 100 });
    assert.equal(info.pageCount, 4); assert.equal(info.widthPt, 220); assert.equal(info.heightPt, 120);
    assert.deepEqual(info.counts, { form: 2, image: 2, path: 1, text: 3 });
    const nested = await editor.query({ text: 'Nested' });
    assert.equal(nested.matched, 2); assert.notEqual(nested.objects[0].id, nested.objects[1].id);
    assert.ok(Math.abs(nested.objects[1].boundsPt.x - nested.objects[0].boundsPt.x - 70) < .001);
    const operations = [
      { op: 'page.crop', page: 0, rectPt: { x: 20, y: 10, width: 180, height: 90 } },
      { op: 'page.crop', page: 1, rectPt: { x: 20, y: 40, width: 180, height: 340 } },
      { op: 'page.crop', page: 2, rectPt: { x: 20, y: 10, width: 180, height: 90 } },
      { op: 'page.crop', page: 3, rectPt: { x: 10, y: 20, width: 90, height: 180 } },
    ];
    const output = path.join(work, 'cropped.pdf');
    const receipt = await editor.apply({ sourceSha256: hash, operations, output });
    assert.equal(receipt.validation.rawStreamsPreserved, 4);
    const saved = structure(output);
    const expectedBoxes = [[30,40,210,130], [30,30,200,120], [30,30,210,120], [30,40,210,130]];
    assert.deepEqual(saved.pages.map(page => saved.object(page.object).value['/CropBox']), expectedBoxes);
    const preview = path.join(work, 'source.png');
    await editor.render({ output: preview, dpi: 144 });
    const png = await readFile(preview);
    assert.equal(png.subarray(1,4).toString(), 'PNG'); assert.equal(png.readUInt32BE(16), 440); assert.equal(png.readUInt32BE(20), 240);
    assert.equal(await sha256(file), hash);
  } finally { await editor.close(); }
  noProcess(pid);
});

test('compose keeps vector Forms and original embedded image data, and fits rotated physical page regions', async () => {
  const file = path.join(work, 'compose-source.pdf'); await fixture(file);
  const output = path.join(work, 'composed.pdf');
  const receipt = await composeFigure({ widthPt: 400, heightPt: 200, output, panels: [
    { file, page: 0, targetRectPt: { x: 0, y: 0, width: 200, height: 200 } },
    { file, page: 1, targetRectPt: { x: 200, y: 0, width: 200, height: 200 } },
  ] });
  assert.equal(receipt.validation.panelForms, 2); assert.equal(receipt.validation.rasterized, false);
  assert.ok(Math.abs(receipt.placements[0].scale - 10/11) < 1e-8);
  assert.ok(Math.abs(receipt.placements[1].scale - 5/11) < 1e-8);
  const s = structure(output); assert.equal(s.pages.length, 1);
  const page = s.object(s.pages[0].object).value;
  assert.deepEqual(page['/MediaBox'], [0,0,400,200]);
  const objects = typeof page['/Resources'] === 'string' ? s.object(page['/Resources']).value : page['/Resources'];
  assert.equal(Object.keys(objects['/XObject']).length, 2);
  for (const ref of Object.values(objects['/XObject'])) assert.equal(s.object(ref).stream.dict['/Subtype'], '/Form');
  const embeddedImages = document => Object.entries(document.objects).filter(([, object]) => object.stream?.dict['/Subtype'] === '/Image');
  const rawBytes = (pdf, entry) => execFileSync(qpdf, [`--show-object=${entry[0].slice(4).split(' ')[0]}`, '--raw-stream-data', pdf], { windowsHide: true });
  const sourceImage = embeddedImages(structure(file))[0];
  for (const image of embeddedImages(s)) assert.deepEqual(rawBytes(output, image), rawBytes(file, sourceImage));
  const doc = await openDocument(output);
  try {
    const info = await doc.inspect({ limit: 100 });
    assert.equal(info.pdfVersion, '1.7');
    assert.equal(info.counts.image, 4); assert.equal(info.counts.text, 6);
    for (const image of info.objects.filter(o => o.type === 'image')) assert.deepEqual(image.pixels, [2,2]);
    await doc.render({ output: path.join(work, 'composed.png'), dpi: 144 });
  } finally { await doc.close(); }
});

test('reject stale/unsupported/occupied writes, replay one request, clean cancellation and exit after parent death', async () => {
  const file = path.join(work, 'guards.pdf'); await fixture(file, { large: true });
  const editor = await openDocument(file); const pid = editor.engineInfo.pid;
  const output = path.join(work, 'guards-output.pdf');
  const base = { sourceSha256: editor.source.sha256, requestId: 'same-request', output, operations: [{ op: 'page.crop', page: 0, rectPt: { x: 5, y: 5, width: 1190, height: 1190 } }] };
  try {
    assert.equal((await doctor()).workerStarted, false);
    await assert.rejects(editor.apply({ ...base, sourceSha256: 'stale' }), { code: 'STALE_SOURCE' });
    await assert.rejects(editor.apply({ ...base, operations: [{ op: 'image.replace', target: 'p0/0', value: 'X' }] }), { code: 'UNSUPPORTED_OPERATION' });
    await missing(output);
    await assert.rejects(editor.apply({ ...base, operations: [{ op: 'page.crop', page: 0, rectPt: { x: -1, y: 0, width: 10, height: 10 } }] }), { code: 'OUTSIDE_PAGE' });
    const result = await editor.apply(base);
    assert.equal((await editor.apply(base)).replayed, true);
    await assert.rejects(editor.apply({ ...base, output: path.join(work, 'different.pdf') }), { code: 'REQUEST_ID_CONFLICT' });
    await assert.rejects(editor.apply({ ...base, requestId: 'other' }), { code: 'OUTPUT_EXISTS' });
    assert.equal(await sha256(output), result.outputSha256);
    const original = await readFile(file); await writeFile(file, Buffer.concat([original, Buffer.from('\n% external edit')]));
    await assert.rejects(editor.apply({ ...base, requestId: 'changed' }), { code: 'STALE_SOURCE' });
    await writeFile(file, original);
    const controller = new AbortController();
    const pending = editor.render({ output: path.join(work, 'cancelled.png'), dpi: 360 }, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 30);
    try { await assert.rejects(pending, { code: 'CANCELLED' }); } finally { clearTimeout(timer); }
    await missing(path.join(work, 'cancelled.png'));
  } finally { await editor.close(); }
  noProcess(pid);
  assert.equal((await readdir(work)).some(name => name.startsWith('.pdfedit-')), false);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {PdfEditor} from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)}; const editor=await PdfEditor.create(); console.log(editor.engineInfo.pid); setInterval(()=>{},1000);`], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  const nativePid = Number((await once(child.stdout, 'data'))[0].toString().trim());
  const closed = once(child, 'close'); child.kill(); await closed;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(nativePid, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Native worker survived parent exit');
});
