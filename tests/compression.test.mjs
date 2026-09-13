import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, composeFigure, sha256 } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const qpdf = path.join(root, 'vendor/qpdf/qpdf-12.4.1-msvc64/bin/qpdf.exe');
function structure(file) {
  const data = JSON.parse(execFileSync(qpdf, ['--json', '--json-key=pages', '--json-key=qpdf',
    '--json-stream-data=inline', '--decode-level=none', file], { windowsHide: true }));
  return { pages: data.pages, objects: data.qpdf[1], object: ref => data.qpdf[1][`obj:${ref}`] };
}
const streams = data => Object.values(data.objects).filter(object => object.stream).map(object => object.stream);
const signature = stream => JSON.stringify([stream.dict['/Filter'] ?? null, stream.dict['/DecodeParms'] ?? null, stream.data]);
function includesStreams(actual, expected) {
  const remaining = actual.map(signature);
  for (const stream of expected) {
    const index = remaining.indexOf(signature(stream));
    assert.notEqual(index, -1, 'Original encoded stream and filters must survive');
    remaining.splice(index, 1);
  }
}

test('compresses new edit and panel streams while preserving even uncompressed source resources', async () => {
  await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
  const work = await mkdtemp(path.join(root, 'artifacts/tests/compression-'));
  const file = path.join(work, 'uncompressed.pdf');
  await fixture(file, { compress: false });
  const hash = await sha256(file), original = structure(file), originalStreams = streams(original);
  assert.equal(originalStreams.length, 4);
  assert.ok(originalStreams.every(stream => !stream.dict['/Filter']));
  const editor = await openDocument(file);
  try {
    const target = (await editor.query({ text: 'Panel A' })).objects[0];
    const edit = await editor.apply({ sourceSha256: hash, output: path.join(work, 'edited.pdf'), operations: [
      { op: 'text.replace', page: 0, target: target.id, expect: { text: 'Panel A' }, value: 'A Panel' },
    ] });
    assert.equal(edit.validation.originalRawStreamsPreserved, 4);
    assert.equal(edit.validation.pixelGates[0].changedPixelsOutside, 0);
    const changed = structure(edit.output);
    includesStreams(streams(changed), originalStreams);
    assert.equal(changed.pages[0].contents.length, 1);
    assert.equal(changed.object(changed.pages[0].contents[0]).stream.dict['/Filter'], '/FlateDecode');

    const crop = await editor.apply({ sourceSha256: hash, output: path.join(work, 'cropped.pdf'), operations: [
      { op: 'page.crop', page: 0, rectPt: { x: 1, y: 1, width: 218, height: 118 } },
    ] });
    const croppedStreams = streams(structure(crop.output));
    assert.equal(croppedStreams.length, 4);
    includesStreams(croppedStreams, originalStreams);

    const composition = await composeFigure({ widthPt: 440, heightPt: 120, output: path.join(work, 'panels.pdf'), panels: [
      { file, page: 0, targetRectPt: { x: 0, y: 0, width: 220, height: 120 } },
      { file, page: 0, targetRectPt: { x: 220, y: 0, width: 220, height: 120 } },
    ] });
    const composed = structure(composition.output);
    const composedStreams = streams(composed);
    includesStreams(composedStreams, originalStreams.filter(stream => stream.dict['/Type'] === '/XObject'));
    assert.equal(composedStreams.filter(stream => stream.dict['/Filter'] === '/FlateDecode').length, 3,
      'Only the two generated panel wrappers and placement content are compressed');
    await editor.open(composition.output);
    assert.deepEqual((await editor.inspect({ mapping: false, limit: 0 })).counts, { form: 6, image: 4, path: 2, text: 6 });
    await editor.render({ dpi: 144, output: path.join(work, 'panels.png') });
    assert.equal(await sha256(file), hash);
  } finally { await editor.close(); }
});
