import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256 } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/edits-'));
const closeEnough = (a, b) => assert.ok(Math.abs(a-b) < .0002, `${a} != ${b}`);
const sourceObjects = info => info.objects.map(({ editable, sourceMapping, supportedOperations, editReason, editReasonCode, textSource, reusableCharacters, sourceCommand, strokeWidthPt, ...rest }) => rest);

test('batch text/style edits preserve the following text cursor, rotated physical units and other pages sharing both streams', async () => {
  const file = path.join(work, 'shared-text-state.pdf');
  await fixture(file, { content: 'q\n0.1 0.2 0.3 RG .75 w 30 40 m 190 40 l S\nBT /F1 12 Tf .2 Tc .6 Tw 80 Tz 1 0 0 1 30 115 Tm [(Pan) 30 (el A)] TJ /Span BMC ( A) Tj EMC ET\n' });
  const hash = await sha256(file), editor = await openDocument(file);
  try {
    const page = await editor.inspect({ page: 1, limit: 100 });
    const text = page.objects.find(o => o.textSource === 'Panel A');
    const next = page.objects.find(o => o.textSource === ' A');
    const line = page.objects.find(o => o.type === 'path');
    assert.equal(text.editable, true); assert.equal(line.strokeWidthPt, 1.5);
    // Helvetica's fixed widths for 'Panel A' sum to 3502 / 1000 em.
    // TJ subtracts .36; Tc adds 1.4; Tw adds .6; Tz scales advance to 80%.
    closeEnough(next.matrix[4], 30 + (42.024 - .36 + 1.4 + .6) * .8);
    const untouched = await editor.inspect({ page: 0, mapping: false, limit: 100 });
    const output = path.join(work, 'shared-edited.pdf');
    const receipt = await editor.apply({ sourceSha256: hash, output, operations: [
      { op: 'text.replace', page: 1, target: text.id, expect: { text: text.textSource }, value: 'A Panel', fontSizePt: 30, fill: '#123456' },
      { op: 'path.style', page: 1, target: line.id, strokeWidthPt: 3, stroke: '#336699' },
    ] });
    assert.equal(receipt.validation.originalRawStreamsPreserved, 4);
    assert.equal(receipt.validation.pixelGates[0].changedPixelsOutside, 0);
    assert.ok(receipt.validation.pixelGates[0].changedPixelsInside > 0);
    const after = await openDocument(output);
    try {
      const edited = await after.inspect({ page: 1, limit: 100 });
      const result = edited.objects.find(o => o.id === text.id);
      assert.equal(result.textSource, 'A Panel'); closeEnough(result.fontSizeYPt, 30);
      closeEnough(edited.objects.find(o => o.id === line.id).strokeWidthPt, 3);
      const following = edited.objects.find(o => o.id === next.id);
      next.matrix.forEach((n,i) => closeEnough(following.matrix[i], n));
      assert.deepEqual(sourceObjects(await after.inspect({ page: 0, mapping: false, limit: 100 })), sourceObjects(untouched));
      await after.render({ page: 1, output: path.join(work, 'shared-edited.png'), dpi: 144 });
    } finally { await after.close(); }
    assert.equal(await sha256(file), hash);
  } finally { await editor.close(); }
});

// Independent PDF construction exercises two-byte codes, a bfrange array and
// CID widths without depending on private user samples or an embedded font file.
async function cidFixture(file) {
  const stream = value => `<< /Length ${Buffer.byteLength(value, 'latin1')} >>\nstream\n${value}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Arial /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 500 /W [1 [667.75 667.75]] /CIDToGIDMap /Identity >>',
    '<< /Type /FontDescriptor /FontName /Arial /Flags 32 /FontBBox [-665 -325 2000 1040] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 716 /StemV 80 >>',
    stream('/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /TestUnicode def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange 1 beginbfrange <0001> <0002> [<0041> <0042>] endbfrange endcmap CMapName currentdict /CMap defineresource pop end end'),
    stream('BT /F1 20 Tf 1 0 0 1 20 100 Tm [<00010002>] TJ /Span BMC <0002> Tj EMC ET'),
  ];
  let bytes = '%PDF-1.7\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(bytes, 'latin1')); bytes += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(bytes, 'latin1');
  bytes += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(file, Buffer.from(bytes, 'latin1'));
}

test('Identity-H replacement reuses observed codes and CID metrics with bfrange-array ToUnicode', async () => {
  const file = path.join(work, 'cid.pdf'); await cidFixture(file);
  const editor = await openDocument(file);
  try {
    const before = await editor.inspect({ limit: 100 });
    const target = before.objects.find(o => o.textSource === 'AB');
    assert.equal(target.editable, true); assert.equal(target.reusableCharacters, 'AB');
    const second = before.objects.find(o => o.textSource === 'B');
    closeEnough(second.matrix[4], 46.68);
    const output = path.join(work, 'cid-edited.pdf');
    const result = await editor.apply({ sourceSha256: editor.source.sha256, output, operations: [
      { op: 'text.replace', page: 0, target: target.id, expect: { text: 'AB' }, value: 'BAA', fontSizePt: 22 },
    ] });
    assert.equal(result.validation.pixelGates[0].changedPixelsOutside, 0);
    const after = await openDocument(output);
    try {
      const info = await after.inspect({ limit: 100 });
      assert.equal(info.objects.find(o => o.id === target.id).textSource, 'BAA');
      closeEnough(info.objects.find(o => o.id === second.id).matrix[4], 46.68);
    } finally { await after.close(); }
  } finally { await editor.close(); }
});

test('fail closed for unobserved characters, stale text, duplicate shapes, clipping paints and nested Forms', async () => {
  const file = path.join(work, 'edit-guards.pdf');
  await fixture(file, { content: 'q\n.75 w 30 40 m 190 40 l S 30 40 m 190 40 l S\n30 50 m 190 50 l W S\nBT /F1 12 Tf 1 0 0 1 30 115 Tm (Panel A) Tj ET\n' });
  const editor = await openDocument(file), output = path.join(work, 'must-not-exist.pdf');
  try {
    const info = await editor.inspect({ limit: 100 });
    const text = info.objects.find(o => o.textSource === 'Panel A');
    assert.equal(text.editable, true);
    const paths = info.objects.filter(o => o.type === 'path');
    assert.equal(paths.length, 3); assert.ok(paths.every(o => !o.editable));
    assert.ok(paths.some(o => o.editReason.includes('clipping')));
    const base = { sourceSha256: editor.source.sha256, output };
    const replacement = { op: 'text.replace', page: 0, target: text.id, expect: { text: 'Panel A' }, value: 'Panel Z' };
    await assert.rejects(editor.apply({ ...base, operations: [replacement] }), { code: 'FONT_CODE_UNVERIFIED' });
    await assert.rejects(editor.apply({ ...base, operations: [{ ...replacement, expect: { text: 'old' } }] }), { code: 'PRECONDITION_FAILED' });
    await assert.rejects(editor.apply({ ...base, operations: [{ op: 'path.style', page: 0, target: paths[0].id, stroke: '#112233' }] }), { code: 'OBJECT_NOT_EDITABLE' });
    const nested = info.objects.find(o => o.depth === 1 && o.type === 'text');
    await assert.rejects(editor.apply({ ...base, operations: [{ ...replacement, target: nested.id }] }), { code: 'OBJECT_NOT_EDITABLE' });
    await assert.rejects(access(output), { code: 'ENOENT' });
  } finally { await editor.close(); }
});
