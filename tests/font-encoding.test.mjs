import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, sha256 } from '../src/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/encoding-'));

// Two pages share a simple font and content; the second page is rotated.
// Expectations below come from the explicit character codes and glyph names.
async function sample(file, encoding, { indirect = false, content = '<412D422043AD44>', cmap = null } = {}) {
  const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[0, 90].map(rotation => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Rotate ${rotation} /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>`),
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${indirect ? '7 0 R' : encoding} ${cmap ? '/ToUnicode 8 0 R' : ''} >>`,
    stream(`BT /F1 12 Tf 1 0 0 1 30 110 Tm ${content} Tj /Span BMC (ABCD) Tj EMC ET`),
    encoding,
    cmap ? stream(cmap) : 'null',
  ];
  let pdf = '%PDF-1.7\n', offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  await writeFile(file, pdf);
}

test('simple encoding dictionaries preserve minus/hyphen, replacement, rotation and shared pages', async () => {
  for (const [i, encoding] of [
    '<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [45 /minus 173 /hyphen] >>',
    '<< /BaseEncoding /StandardEncoding /Differences [45 /minus 173 /hyphen] >>',
    '<< /Differences [45 /minus 173 /hyphen] >>',
  ].entries()) {
    const input = path.join(work, `valid-${i}.pdf`), output = path.join(work, `valid-${i}-edited.pdf`);
    await sample(input, encoding, { indirect: i !== 1 });
    const hash = await sha256(input), editor = await openDocument(input);
    try {
      const before = await editor.query({ page: 1, type: 'text' });
      const target = before.objects[0];
      assert.equal(target.editable, true, target.editReason);
      assert.equal(target.textSource, 'A−B C-D');
      assert.ok(target.reusableCharacters.includes('−') && target.reusableCharacters.includes('-'));
      const untouched = await editor.query({ page: 0, mapping: false });
      const receipt = await editor.apply({ sourceSha256: hash, output, operations: [
        { op: 'text.replace', page: 1, target: target.id, expect: { text: 'A−B C-D' }, value: 'C-D A−B' },
      ] });
      assert.equal(receipt.validation.pixelGates[0].changedPixelsOutside, 0);
      assert.ok(receipt.validation.pixelGates[0].changedPixelsInside > 0);
      await editor.open(output);
      const after = await editor.query({ page: 1, type: 'text' });
      assert.equal(after.objects[0].textSource, 'C-D A−B');
      assert.equal(after.objects[1].textSource, 'ABCD');
      before.objects[1].matrix.forEach((value, j) => assert.ok(Math.abs(after.objects[1].matrix[j] - value) < .0002));
      assert.deepEqual((await editor.query({ page: 0, mapping: false })).objects, untouched.objects);
      assert.equal(await sha256(input), hash);
    } finally { await editor.close(); }
  }
});

test('invalid encoding dictionaries and unmapped glyphs fail closed with stable diagnostics', async () => {
  const cases = [
    ['<< /BaseEncoding /MacRomanEncoding >>', 'FONT_ENCODING_UNSUPPORTED'],
    ['<< /BaseEncoding /WinAnsiEncoding /Differences (bad) >>', 'FONT_ENCODING_INVALID'],
    ['<< /Differences [/minus] >>', 'FONT_ENCODING_INVALID'],
    ['<< /Differences [256 /minus] >>', 'FONT_ENCODING_INVALID'],
    ['<< /Differences [-1 /minus] >>', 'FONT_ENCODING_INVALID'],
    ['<< /Differences [255 /minus /hyphen] >>', 'FONT_ENCODING_INVALID'],
    ['<< /Differences [45 /minus 45 /hyphen] >>', 'FONT_ENCODING_INVALID'],
    ['<< /Differences [45 1.5] >>', 'FONT_ENCODING_INVALID'],
    ['<< /BaseEncoding /WinAnsiEncoding /Differences [45 /unknownGlyph] >>', 'FONT_GLYPH_UNMAPPED'],
    ['<< /BaseEncoding /WinAnsiEncoding /Differences [45 /.notdef] >>', 'FONT_GLYPH_UNMAPPED'],
    ['<< /BaseEncoding /WinAnsiEncoding /Differences [45 /f_f_i] >>', 'FONT_GLYPH_UNMAPPED'],
  ];
  for (const [i, [encoding, code]] of cases.entries()) {
    const input = path.join(work, `invalid-${i}.pdf`), output = path.join(work, `invalid-${i}-output.pdf`);
    await sample(input, encoding, { content: '<412D42>' });
    const hash = await sha256(input), editor = await openDocument(input);
    try {
      const { objects } = await editor.query({ type: 'text' });
      assert.equal(objects[0].editable, false);
      assert.equal(objects[0].editReasonCode, code, objects[0].editReason);
      assert.ok(objects[0].editReason.length > 0);
      // An unknown, unused glyph must not disable otherwise supported text.
      if (code === 'FONT_GLYPH_UNMAPPED') assert.equal(objects[1].editable, true);
      await assert.rejects(editor.apply({ sourceSha256: hash, output, operations: [
        { op: 'text.style', page: 0, target: objects[0].id, fontSizePt: 14 },
      ] }), { code: 'OBJECT_NOT_EDITABLE' });
      await assert.rejects(access(output), { code: 'ENOENT' });
      assert.equal(await sha256(input), hash);
    } finally { await editor.close(); }
  }
  const cli = spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), 'query', path.join(work, 'invalid-8.pdf'), '--type', 'text', '--fields', 'editable,editReasonCode,editReason'], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).objects[0].editReasonCode, 'FONT_GLYPH_UNMAPPED');
});

test('explicit ToUnicode keeps priority over Differences', async () => {
  const input = path.join(work, 'tounicode.pdf');
  await sample(input, '<< /BaseEncoding /WinAnsiEncoding /Differences [45 /minus] >>', {
    content: '<412D42>',
    cmap: '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Test def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 5 beginbfchar <2D> <002D> <41> <0041> <42> <0042> <43> <0043> <44> <0044> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end',
  });
  const editor = await openDocument(input);
  try {
    const { objects } = await editor.query({ type: 'text' });
    assert.equal(objects[0].editable, true, objects[0].editReason);
    assert.equal(objects[0].textSource, 'A-B');
    assert.equal(objects[0].reusableCharacters.includes('−'), false);
  } finally { await editor.close(); }
});
