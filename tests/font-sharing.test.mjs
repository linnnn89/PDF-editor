import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { composeFigure, openDocument, sha256, summarizeReceipt } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/font-sharing-'));
const qpdf = path.join(root, 'vendor/qpdf/qpdf-12.4.1-msvc64/bin/qpdf.exe');
const bold = await readFile(path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts/arialbd.ttf'));
const input = path.join(work, 'source.pdf');
await fixture(input, { font: { bytes: bold, name: 'Arial-BoldMT', widths: { A: 722 } },
  content: 'q BT /F1 12 Tf 1 0 0 1 30 115 Tm (A) Tj ET\n' });
const structure = file => JSON.parse(execFileSync(qpdf, ['--json-output', '--json-stream-data=inline', '--decode-level=none', file],
  { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
const descriptors = data => Object.values(data.qpdf[1]).filter(object => object.value?.['/Type'] === '/FontDescriptor');
const programRefs = data => new Set(descriptors(data).map(object => object.value['/FontFile2']));
async function variant(file, mutate, source = input) {
  const data = structure(source);
  const patch = mutate(data);
  const json = file + '.json';
  await writeFile(json, JSON.stringify({ qpdf: [data.qpdf[0], patch] }));
  execFileSync(qpdf, [source, file, `--update-from-json=${json}`, '--stream-data=preserve'], { windowsHide: true });
}
function streamEntry(data) {
  const ref = descriptors(data)[0].value['/FontFile2'];
  return [`obj:${ref}`, data.qpdf[1][`obj:${ref}`].stream];
}
async function compose(second, name) {
  return composeFigure({ widthPt: 660, heightPt: 120, output: path.join(work, name + '.pdf'), panels:
    [input, second, input].map((file, i) => ({ file, page: 0, targetRectPt: { x: i * 220, y: 0, width: 220, height: 120 } })) });
}

test('composition shares identical programs across sources while retaining separate font metrics and identical rendering', async () => {
  const second = path.join(work, 'other-widths.pdf');
  await variant(second, data => {
    const [ref, font] = Object.entries(data.qpdf[1]).find(([, object]) => object.value?.['/Subtype'] === '/TrueType');
    font.value['/Widths'][65 - font.value['/FirstChar']] = 500;
    return { [ref]: font };
  });
  const originalHashes = await Promise.all([input, second].map(sha256));
  const shared = await compose(second, 'shared');
  const saved = structure(shared.output);
  assert.equal(descriptors(saved).length, 2);
  assert.equal(programRefs(saved).size, 1);
  const fonts = Object.values(saved.qpdf[1]).filter(object => object.value?.['/Subtype'] === '/TrueType');
  assert.deepEqual(fonts.map(({ value }) => value['/Widths'][65 - value['/FirstChar']]).sort((a, b) => a - b), [500, 722]);
  const [, sourceProgram] = streamEntry(structure(input));
  assert.deepEqual(shared.optimization, { fontProgramsShared: 1, encodedFontBytesShared: Buffer.from(sourceProgram.data, 'base64').length });
  assert.deepEqual(summarizeReceipt(shared).optimization, shared.optimization);
  assert.equal(saved.qpdf[1][`obj:${[...programRefs(saved)][0]}`].stream.data, sourceProgram.data);

  // An ignored PDF extension key makes program dictionaries different, giving
  // an independent unshared rendering control with the same bytes and metrics.
  const controlInput = path.join(work, 'control-marker.pdf');
  await variant(controlInput, data => {
    const [ref, stream] = streamEntry(data);
    return { [ref]: { stream: { dict: { ...stream.dict, '/TestMarker': '/unshared' } } } };
  }, second);
  const control = await compose(controlInput, 'control');
  assert.equal(programRefs(structure(control.output)).size, 2);
  const details = [], previews = [];
  for (const [i, file] of [shared.output, control.output].entries()) {
    const editor = await openDocument(file), png = path.join(work, `preview-${i}.png`);
    try {
      details.push((await editor.inspect({ mapping: false, limit: 100 })).objects);
      await editor.render({ dpi: 144, output: png }); previews.push(await readFile(png));
    } finally { await editor.close(); }
  }
  assert.deepEqual(details[0], details[1]);
  assert.deepEqual(previews[0], previews[1]);
  assert.deepEqual(await Promise.all([input, second].map(sha256)), originalHashes);
});

test('composition keeps different stream dictionaries or different encoded font bytes separate', async () => {
  for (const kind of ['dictionary', 'encoded-bytes']) {
    const second = path.join(work, kind + '.pdf');
    await variant(second, data => {
      const [ref, stream] = streamEntry(data);
      if (kind === 'dictionary') stream.dict['/TestMarker'] = '/different';
      else {
        const bytes = deflateSync(bold, { level: 9 });
        assert.notDeepEqual(bytes, Buffer.from(stream.data, 'base64'));
        stream.data = bytes.toString('base64');
      }
      return { [ref]: { stream } };
    });
    const receipt = await compose(second, kind + '-result');
    assert.equal(programRefs(structure(receipt.output)).size, 2);
    assert.deepEqual(receipt.optimization, { fontProgramsShared: 0, encodedFontBytesShared: 0 });
  }
});
