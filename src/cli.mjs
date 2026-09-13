#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { doctor, openDocument, composeFigure, PdfError, version } from './index.mjs';

const help = `Agent PDF Editor ${version} (Windows x64, Node.js 24)
  node src/cli.mjs doctor
  node src/cli.mjs inspect INPUT.pdf [--page 0] [--limit 100] [--offset 0]
  node src/cli.mjs query INPUT.pdf [--text Control] [--type text] [--page 0]
  node src/cli.mjs render INPUT.pdf --output OUTPUT.png [--page 0] [--dpi 144]
  node src/cli.mjs apply INPUT.pdf PLAN.json
  node src/cli.mjs compose PLAN.json

Page indices are zero based. Geometry is physical pt from the top-left of the
rotated visible page. JSON results go to stdout; errors go to stderr.
apply requires sourceSha256, operations and an absolute output path in PLAN.json.
Writes page.crop, vector compositions, and verified text.replace/text.style/path.style.
Use inspect results for supportedOperations, textSource and reusableCharacters.
reusableCharacters is a fast path; other characters require verified font extension.
`;
let editor;
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort); process.once('SIGTERM', abort);
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    page: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' },
    text: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' },
    output: { type: 'string' }, dpi: { type: 'string' }, help: { type: 'boolean' },
    'no-mapping': { type: 'boolean' }, editable: { type: 'boolean' },
  }});
  const [command, input, planFile] = positionals;
  let result;
  if (!command || values.help || command === 'help') process.stdout.write(help);
  else if (command === 'doctor') result = await doctor();
  else if (command === 'compose') result = await composeFigure(JSON.parse(await readFile(input, 'utf8')), { signal: controller.signal });
  else {
    if (!['inspect', 'query', 'render', 'apply'].includes(command)) throw new PdfError('INVALID_ARGUMENT', `Unknown command: ${command}`);
    editor = await openDocument(input, { signal: controller.signal });
    const params = {};
    for (const key of ['page', 'limit', 'offset', 'dpi']) if (values[key] !== undefined) {
      if (!values[key].trim() || !Number.isFinite(Number(values[key]))) throw new PdfError('INVALID_ARGUMENT', `${key} must be numeric`);
      params[key] = Number(values[key]);
    }
    for (const key of ['text', 'type', 'id']) if (values[key] !== undefined) params[key] = values[key];
    if (values['no-mapping']) params.mapping = false;
    if (values.editable) params.editable = true;
    if (command === 'apply') result = await editor.apply(JSON.parse(await readFile(planFile, 'utf8')), { signal: controller.signal });
    else if (command === 'render') {
      if (!values.output) throw new PdfError('INVALID_ARGUMENT', '--output is required');
      result = await editor.render({ ...params, output: path.resolve(values.output) }, { signal: controller.signal });
    } else result = await editor[command](params, { signal: controller.signal });
  }
  if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'ERROR', message: error.message, details: error.details } }, null, 2)}\n`);
  process.exitCode = error.code === 'CANCELLED' ? 130 : 1;
} finally { if (editor) await editor.close(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
