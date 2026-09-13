import path from 'node:path';
import { parseArgs } from 'node:util';
import { openDocument, planTextReplacements, PdfError, summarizeReceipt } from '../src/index.mjs';

// A deliberately narrow example: the caller selects the label column;
// ordinary JavaScript supplies the formatting rule, without model calls.
let editor;
try {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, output: { type: 'string' }, 'within-rect': { type: 'string' },
    page: { type: 'string', default: '0' }, 'expected-count': { type: 'string' },
  } });
  if (!values.input || !values.output || !values['within-rect']) {
    throw new PdfError('INVALID_ARGUMENT', 'Use --input figure.pdf --output renamed.pdf --within-rect x,y,width,height [--page 0] [--expected-count 7]');
  }
  const coordinates = values['within-rect'].split(',').map(item => item.trim());
  if (coordinates.length !== 4 || coordinates.some(item => !item || !Number.isFinite(Number(item)))) {
    throw new PdfError('INVALID_ARGUMENT', '--within-rect requires four finite numbers: x,y,width,height');
  }
  const [x, y, width, height] = coordinates.map(Number);
  const withinRectPt = { x, y, width, height };
  const page = Number(values.page);
  if (!values.page.trim() || !Number.isInteger(page) || page < 0) throw new PdfError('INVALID_ARGUMENT', 'page must be a nonnegative integer');
  let expectedCount;
  if (values['expected-count'] !== undefined) {
    expectedCount = Number(values['expected-count']);
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 100) {
      throw new PdfError('INVALID_ARGUMENT', 'expected-count must be an integer from 1 to 100');
    }
  }
  editor = await openDocument(path.resolve(values.input));
  const labels = await editor.query({ page, type: 'text', withinRectPt, limit: 10000,
    fields: ['textSource', 'editable', 'supportedOperations'] });
  const issues = [], replacements = [];
  if (expectedCount !== undefined && labels.objects.length !== expectedCount) {
    issues.push({ code: 'COUNT_MISMATCH', expected: expectedCount, actual: labels.objects.length });
  }
  for (const label of labels.objects) {
    const match = typeof label.textSource === 'string' && /^(.+) (\d{4})$/.exec(label.textSource);
    if (!match) issues.push({ code: 'LABEL_FORMAT_MISMATCH', target: label.id, textSource: label.textSource });
    else replacements.push({ from: label.textSource, to: `${match[1]} (${match[2]})` });
  }
  if (issues.length) throw new PdfError('INVALID_ARGUMENT', 'Selected labels do not meet the rule', { issues });
  const plan = planTextReplacements(labels, replacements);
  const receipt = await editor.apply({ ...plan, output: path.resolve(values.output),
    textBounds: [{ page, targets: plan.operations.map(operation => operation.target), withinRectPt }] });
  console.log(JSON.stringify(summarizeReceipt(receipt), null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? 'ERROR', message: error.message, details: error.details } }, null, 2));
  process.exitCode = 1;
} finally {
  if (editor) await editor.close();
}
