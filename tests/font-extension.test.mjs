import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256 } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/fonts-'));
const fontDir = path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts');
const bold = await readFile(path.join(fontDir, 'arialbd.ttf'));
// Fixed Arial Bold PDF advances, independent of the editor's calculations.
const widths = { ' ': 277, A: 722, N: 722, O: 777, S: 666, a: 556, d: 610,
  e: 556, l: 277, n: 610, r: 389, s: 556, t: 333, u: 610, v: 556, y: 556 };
const near = (a, b) => assert.ok(Math.abs(a-b) < .0002, `${a} != ${b}`);
const shape = o => ({ type: o.type, text: o.text, font: o.font, boundsPt: o.boundsPt, matrix: o.matrix, fill: o.fill });

// Manufacture a font with an ASCII-only cmap and no 'v'. Keep its outlines
// intact so an independently installed exact face can be verified. No private
// PDF/font fixture is checked in; only copies of Windows fonts are modified.
function withoutV(bytes) {
  const out = Buffer.from(bytes), tables = new Map();
  for (let i = 0; i < out.readUInt16BE(4); i++) {
    const at = 12+i*16; tables.set(out.toString('ascii', at, at+4), { at, offset: out.readUInt32BE(at+8), length: out.readUInt32BE(at+12) });
  }
  const cmap = tables.get('cmap'); let format;
  for (let i = 0; i < out.readUInt16BE(cmap.offset+2); i++) {
    const at = cmap.offset+4+i*8, offset = cmap.offset+out.readUInt32BE(at+4);
    if (out.readUInt16BE(at) === 3 && out.readUInt16BE(at+2) === 1 && out.readUInt16BE(offset) === 4) format = offset;
  }
  assert.ok(format, 'Windows Arial must expose its BMP cmap');
  const segments = out.readUInt16BE(format+6)/2;
  const glyph = u => {
    for (let i = 0; i < segments; i++) {
      const end = out.readUInt16BE(format+14+i*2), start = out.readUInt16BE(format+16+segments*2+i*2);
      if (u < start || u > end) continue;
      const delta = out.readInt16BE(format+16+segments*4+i*2), at = format+16+segments*6+i*2, range = out.readUInt16BE(at);
      const g = range ? out.readUInt16BE(at+range+2*(u-start)) : u;
      return range && g === 0 ? 0 : (g+delta)&65535;
    }
    return 0;
  };
  assert.ok(glyph(118));
  const chars = Array.from({ length: 95 }, (_, i) => i+32).filter(u => u !== 118);
  chars.push(65535);
  const count = chars.length, length = 16+count*8, replacement = Buffer.alloc(12+length);
  replacement.writeUInt16BE(1, 2); replacement.writeUInt16BE(3, 4); replacement.writeUInt16BE(1, 6); replacement.writeUInt32BE(12, 8);
  const f = replacement.subarray(12); f.writeUInt16BE(4); f.writeUInt16BE(length, 2); f.writeUInt16BE(count*2, 6);
  const selector = Math.floor(Math.log2(count)), search = 2*2**selector;
  f.writeUInt16BE(search, 8); f.writeUInt16BE(selector, 10); f.writeUInt16BE(count*2-search, 12);
  chars.forEach((u, i) => {
    f.writeUInt16BE(u, 14+i*2); f.writeUInt16BE(u, 16+count*2+i*2);
    f.writeUInt16BE(((u === 65535 ? 0 : glyph(u))-u)&65535, 16+count*4+i*2);
  });
  assert.ok(replacement.length <= cmap.length);
  replacement.copy(out, cmap.offset); out.fill(0, cmap.offset+replacement.length, cmap.offset+cmap.length);
  const checksum = data => {
    let sum = 0; for (let i = 0; i < data.length; i += 4) {
      let word = 0; for (let k = 0; k < 4; k++) word = word*256+(data[i+k] ?? 0);
      sum = (sum+word)>>>0;
    } return sum;
  };
  out.writeUInt32BE(replacement.length, cmap.at+12); out.writeUInt32BE(checksum(replacement), cmap.at+4);
  const head = tables.get('head'); out.writeUInt32BE(0, head.offset+8);
  out.writeUInt32BE((0xB1B0AFBA-checksum(out))>>>0, head.offset+8);
  return out;
}

test('unobserved embedded glyphs preserve TJ/Tc/Tw/Tz, following text and shared pages', async () => {
  const input = path.join(work, 'embedded.pdf');
  await fixture(input, { font: { bytes: bold, name: 'Arial-BoldMT', widths },
    content: 'q BT /F1 12 Tf .2 Tc .6 Tw 80 Tz 1 0 0 1 30 115 Tm [120 () (Stu) 30 (dy A) 40 ()] TJ /Span BMC ( A) Tj EMC ET\n' });
  const sourceHash = await sha256(input), editor = await openDocument(input);
  try {
    const before = await editor.inspect({ page: 1, limit: 100 }), other = await editor.inspect({ page: 0, mapping: false, limit: 100 });
    const target = before.objects.find(o => o.textSource === 'Study A'), next = before.objects.find(o => o.textSource === ' A');
    assert.ok(!target.reusableCharacters.includes('v'));
    // The source's empty strings make PDFium ignore its terminal 40 TJ.
    near(next.matrix[4], 30+(45.288-.36+1.4+.6-1.44)*.8);
    for (const [key, value] of [['word-space', 'Overall A'], ['trailing-space', 'Overall ']]) {
      const receipt = await editor.apply({ sourceSha256: sourceHash, output: path.join(work, `embedded-${key}.pdf`), operations: [
        { op: 'text.replace', page: 1, target: target.id, expect: { text: target.textSource }, value, fontSizePt: 30, fill: '#155E75' },
      ] });
      assert.equal(receipt.validation.fontExpansions[0].source, 'embedded-font-program');
      assert.equal(receipt.validation.pixelGates[0].changedPixelsOutside, 0);
      assert.equal(receipt.validation.whitespaceSourceChecks, key === 'trailing-space' ? 1 : 0);
      const output = await openDocument(receipt.output);
      try {
        const after = await output.inspect({ page: 1, limit: 100 });
        assert.equal(after.objects.find(o => o.id === target.id).textSource, value);
        near(after.objects.find(o => o.id === target.id).fontSizeYPt, 30);
        const following = after.objects.find(o => o.id === next.id);
        assert.equal(following.textSource, next.textSource); assert.equal(following.font, next.font);
        following.matrix.forEach((value, i) => near(value, next.matrix[i]));
        for (const key of Object.keys(next.boundsPt)) near(following.boundsPt[key], next.boundsPt[key]);
        assert.deepEqual((await output.inspect({ page: 0, mapping: false, limit: 100 })).objects.map(shape), other.objects.map(shape));
      } finally { await output.close(); }
      await writeFile(path.join(work, `embedded-${key}-receipt.json`), JSON.stringify(receipt, null, 2));
    }
  } finally { await editor.close(); }
  assert.equal(await sha256(input), sourceHash);
});

test('a missing subset character loads the exact installed face and remains editable after reopening', async () => {
  const input = path.join(work, 'subset.pdf');
  await fixture(input, { font: { bytes: withoutV(bold), name: 'Arial-BoldMT', widths }, content: 'q BT /F1 12 Tf 1 0 0 1 30 115 Tm (Study) Tj ET\n' });
  const hash = await sha256(input), editor = await openDocument(input);
  try {
    const target = (await editor.inspect({ limit: 100 })).objects.find(o => o.textSource === 'Study');
    const receipt = await editor.apply({ sourceSha256: hash, output: path.join(work, 'subset-edited.pdf'), operations: [
      { op: 'text.replace', page: 0, target: target.id, expect: { text: 'Study' }, value: 'Overall' },
    ] });
    const font = receipt.validation.fontExpansions[0];
    assert.equal(font.source, 'matching-installed-font'); assert.equal(font.postScriptName, 'Arial-BoldMT');
    assert.ok(font.observedGlyphsVerified >= 5); assert.ok(font.addedCharacters.includes('v'));
    const output = await openDocument(receipt.output);
    try {
      const changed = (await output.inspect({ limit: 100 })).objects.find(o => o.id === target.id);
      assert.equal(changed.textSource, 'Overall'); assert.equal(changed.editable, true); assert.equal(changed.fontEmbedded, true);
      const next = await output.apply({ sourceSha256: output.source.sha256, output: path.join(work, 'subset-reedited.pdf'), operations: [
        { op: 'text.replace', page: 0, target: changed.id, expect: { text: changed.textSource }, value: 'Overall - A\u00a0v' },
      ] });
      assert.equal(next.validation.fontExpansions[0].source, 'embedded-font-program');
      assert.equal(next.changes[0].after.text, 'Overall - A\u00a0v');
      assert.equal(next.validation.pixelGates[0].changedPixelsOutside, 0);
    } finally { await output.close(); }
    await writeFile(path.join(work, 'subset-receipt.json'), JSON.stringify(receipt, null, 2));
  } finally { await editor.close(); }
  assert.equal(await sha256(input), hash);
});

test('a matching font name with different outlines fails without publishing or changing the source', async () => {
  const input = path.join(work, 'wrong-outlines.pdf'), output = path.join(work, 'must-not-exist.pdf');
  const regular = await readFile(path.join(fontDir, 'arial.ttf'));
  await fixture(input, { font: { bytes: withoutV(regular), name: 'Arial-BoldMT', widths }, content: 'q BT /F1 12 Tf 1 0 0 1 30 115 Tm (Study) Tj ET\n' });
  const hash = await sha256(input), editor = await openDocument(input);
  try {
    const target = (await editor.inspect({ limit: 100 })).objects.find(o => o.textSource === 'Study');
    await assert.rejects(editor.apply({ sourceSha256: hash, output, operations: [
      { op: 'text.replace', page: 0, target: target.id, expect: { text: 'Study' }, value: 'Overall' },
    ] }), { code: 'FONT_FACE_MISMATCH' });
    await assert.rejects(access(output), { code: 'ENOENT' });
    assert.equal((await editor.inspect({ limit: 100 })).objects.find(o => o.id === target.id).textSource, 'Study');
  } finally { await editor.close(); }
  assert.equal(await sha256(input), hash);
});
