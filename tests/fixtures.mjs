import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

// A tiny known PDF, not a renderer round-trip: split streams, a repeated Form,
// a bitmap, visible text, inherited boxes, rotations and UserUnit scaling.
export async function fixture(file, { large = false, content = null, font = null } = {}) {
  const objects = [];
  const add = body => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'ascii')); return objects.length; };
  const stream = (data, dictionary = '') => {
    const bytes = deflateSync(Buffer.from(data));
    return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} /Filter /FlateDecode ${dictionary} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 /MediaBox [0 0 ${large ? '1200 1200' : '240 160'}] /Resources << /Font << /F1 7 0 R >> /XObject << /Fm 10 0 R >> >> >>`);
  for (const rotation of [0, 90, 180, 270]) add(`<< /Type /Page /Parent 2 0 R ${large ? '' : '/CropBox [10 20 230 140]'} /Rotate ${rotation} /UserUnit ${rotation === 90 ? 2 : 1} /Contents [8 0 R 9 0 R] >>`);
  if (font) {
    const widths = Array.from({ length: 95 }, (_, i) => font.widths[String.fromCharCode(i+32)] ?? 0);
    add(`<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+${font.name} /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [${widths.join(' ')}] /FontDescriptor 12 0 R >>`);
  } else add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  add(stream(content ?? 'q\n0.1 0.2 0.3 RG 0.75 w 30 40 m 190 40 l S\nBT /F1 12 Tf 1 0 0 1 30 115 Tm (Panel A) Tj ET\n'));
  add(stream('q 1 0 0 1 30 60 cm /Fm Do Q\nq 1 0 0 1 100 60 cm /Fm Do Q\nQ'));
  add(stream('0 0 0 rg BT /F1 10 Tf 1 0 0 1 0 15 Tm (Nested) Tj ET q 10 0 0 10 2 0 cm /Im Do Q', '/Type /XObject /Subtype /Form /BBox [0 0 60 30] /Resources << /Font << /F1 7 0 R >> /XObject << /Im 11 0 R >> >>'));
  add(stream(Buffer.from([255,0,0, 0,255,0, 0,0,255, 255,255,0]), '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8'));
  if (font) {
    add(`<< /Type /FontDescriptor /FontName /ABCDEF+${font.name} /FontFamily (Arial) /Flags 32 /FontBBox [-627 -376 2000 1055] /Ascent 905 /Descent -211 /CapHeight 905 /StemV 120 /ItalicAngle 0 /FontFile2 13 0 R >>`);
    add(stream(font.bytes, `/Length1 ${font.bytes.length}`));
  }
  const chunks = [Buffer.from('%PDF-1.7\n% fixture\n')], offsets = [0];
  let offset = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    const bytes = Buffer.concat([Buffer.from(`${i+1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    chunks.push(bytes); offset += bytes.length;
  }
  const xref = `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref)); await writeFile(file, Buffer.concat(chunks));
}
