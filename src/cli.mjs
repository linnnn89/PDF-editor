#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { doctor, openDocument, composeFigure, PdfError, version } from './index.mjs';
import { summarizeReceipt } from './receipt.mjs';

const help = `Agent PDF Editor ${version} (Windows x64, Node.js 24)
  node src/cli.mjs doctor
  node src/cli.mjs stats INPUT.pdf [--page 0]
  node src/cli.mjs inspect INPUT.pdf [--page 0] [--limit 100] [--offset 0]
  node src/cli.mjs query INPUT.pdf [--text Control] [--type text] [--page 0] [--fields textSource,editable,supportedOperations]
  node src/cli.mjs render INPUT.pdf --output OUTPUT.png [--page 0] [--dpi 144]
  node src/cli.mjs apply INPUT.pdf PLAN.json [--summary] [--report FILE]
  node src/cli.mjs compose PLAN.json [--summary] [--report FILE]

Page indices are zero based. Geometry is physical pt from the top-left of the
rotated visible page. JSON results go to stdout; errors go to stderr.
apply requires sourceSha256, operations and an absolute output path in PLAN.json.
Writes page.crop, vector compositions, and verified text.replace/text.style/path.style.
Use inspect results for supportedOperations, textSource and reusableCharacters.
reusableCharacters is a fast path; other characters require verified font extension.
--fields selects object fields for inspect/query; id and type are always returned.
--within-rect x,y,width,height selects fully contained geometric bounds for inspect/query.
--summary writes a compact receipt to stdout for apply/compose only.
--report FILE writes the complete receipt to a new file and never overwrites a file.
`;
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
async function reserveReport(file, protectedPaths) {
  const resolved = path.resolve(file);
  if (protectedPaths.filter(protectedPath => typeof protectedPath === 'string').some(protectedPath => samePath(resolved, protectedPath))) {
    throw new PdfError('REPORT_PATH_CONFLICT', 'Report file cannot be an input or PDF output path');
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const destination = path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
  try { return { file: destination, handle: await open(destination, 'wx') }; }
  catch (error) {
    if (error.code === 'EEXIST') throw new PdfError('REPORT_EXISTS', 'Report file already exists; choose a new name');
    throw error;
  }
}
async function writeReport(reservation, receipt) {
  await reservation.handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await reservation.handle.sync();
  await reservation.handle.close();
}
let editor;
let reportReservation;
let reportComplete = false;
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort); process.once('SIGTERM', abort);
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    page: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' },
    text: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' }, fields: { type: 'string' },
    output: { type: 'string' }, dpi: { type: 'string' }, help: { type: 'boolean' },
    'no-mapping': { type: 'boolean' }, editable: { type: 'boolean' },
    'within-rect': { type: 'string' },
    summary: { type: 'boolean' }, report: { type: 'string' },
  }});
  const [command, input, planFile] = positionals;
  let result;
  const hasReport = values.report !== undefined;
  if (values.fields !== undefined && !['inspect', 'query'].includes(command)) {
    throw new PdfError('INVALID_ARGUMENT', '--fields is supported only for inspect and query');
  }
  let withinRectPt;
  if (values['within-rect'] !== undefined) {
    if (!['inspect', 'query'].includes(command)) throw new PdfError('INVALID_ARGUMENT', '--within-rect is supported only for inspect and query');
    const parts = values['within-rect'].split(',').map(part => part.trim());
    if (parts.length !== 4 || parts.some(part => !part || !Number.isFinite(Number(part)))) {
      throw new PdfError('INVALID_ARGUMENT', '--within-rect requires four finite numbers: x,y,width,height');
    }
    withinRectPt = Object.fromEntries(['x', 'y', 'width', 'height'].map((key, index) => [key, Number(parts[index])]));
  }
  if (hasReport && values.report.length === 0) throw new PdfError('INVALID_ARGUMENT', '--report requires a nonempty file path');
  if ((values.summary || hasReport) && !['apply', 'compose'].includes(command)) {
    throw new PdfError('INVALID_ARGUMENT', '--summary and --report are supported only for apply and compose');
  }
  if (!command || values.help || command === 'help') process.stdout.write(help);
  else if (command === 'doctor') result = await doctor();
  else if (command === 'compose') {
    const plan = JSON.parse(await readFile(input, 'utf8'));
    if (hasReport) reportReservation = await reserveReport(values.report, [input, plan.output, ...(plan.panels ?? []).map(panel => panel.file)]);
    result = await composeFigure(plan, { signal: controller.signal });
  }
  else {
    if (!['stats', 'inspect', 'query', 'render', 'apply'].includes(command)) throw new PdfError('INVALID_ARGUMENT', `Unknown command: ${command}`);
    let plan;
    if (command === 'apply') {
      plan = JSON.parse(await readFile(planFile, 'utf8'));
      if (hasReport) reportReservation = await reserveReport(values.report, [input, plan.output]);
    }
    if (command === 'stats') {
      if (planFile !== undefined) throw new PdfError('INVALID_ARGUMENT', 'stats accepts only one input PDF');
      const invalid = Object.keys(values).find(key => !['page'].includes(key));
      if (invalid) throw new PdfError('INVALID_ARGUMENT', `--${invalid} is not supported by stats`);
    }
    editor = await openDocument(input, { signal: controller.signal });
    const params = {};
    if (withinRectPt !== undefined) params.withinRectPt = withinRectPt;
    for (const key of ['page', 'limit', 'offset', 'dpi']) if (values[key] !== undefined) {
      if (!values[key].trim() || !Number.isFinite(Number(values[key]))) throw new PdfError('INVALID_ARGUMENT', `${key} must be numeric`);
      params[key] = Number(values[key]);
    }
    for (const key of ['text', 'type', 'id']) if (values[key] !== undefined) params[key] = values[key];
    if (values.fields !== undefined) params.fields = values.fields.split(',').map(field => field.trim());
    if (values['no-mapping']) params.mapping = false;
    if (values.editable) params.editable = true;
    if (command === 'apply') result = await editor.apply(plan, { signal: controller.signal });
    else if (command === 'render') {
      if (!values.output) throw new PdfError('INVALID_ARGUMENT', '--output is required');
      result = await editor.render({ ...params, output: path.resolve(values.output) }, { signal: controller.signal });
    } else result = await editor[command](params, { signal: controller.signal });
  }
  if (result) {
    if (reportReservation) {
      await writeReport(reportReservation, result);
      reportComplete = true;
    }
    process.stdout.write(`${JSON.stringify(values.summary ? summarizeReceipt(result, { report: reportReservation?.file }) : result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'ERROR', message: error.message, details: error.details } }, null, 2)}\n`);
  process.exitCode = error.code === 'CANCELLED' ? 130 : 1;
} finally {
  if (reportReservation && !reportComplete) {
    await reportReservation.handle.close().catch(() => {});
    await rm(reportReservation.file, { force: true }).catch(() => {});
  }
  if (editor) await editor.close();
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
