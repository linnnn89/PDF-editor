import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDocument, PdfError } from '../src/index.mjs';
import { planTextReplacements } from '../src/text-replacements.mjs';
import { fixture } from './fixtures.mjs';

test('exact replacement plans query, apply once with shared style and reopen correctly', async () => {
  const root = fileURLToPath(new URL('../artifacts/tests/', import.meta.url));
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(path.join(root, 'text-replacements-'));
  const input = path.join(work, 'source.pdf');
  await fixture(input, { content: 'q\nBT /F1 12 Tf 1 0 0 1 30 115 Tm (Panel A) Tj ET\nBT /F1 12 Tf 1 0 0 1 110 115 Tm (Panel B) Tj ET\n' });
  const editor = await openDocument(input);
  try {
    const query = await editor.query({ type: 'text', limit: 10000, fields: ['textSource', 'editable', 'supportedOperations'] });
    const replacements = [{ from: 'Panel A', to: 'A Panel' }, { from: 'Panel B', to: 'B Panel' }];
    const style = { fontSizePt: 10, fill: '#123456' };
    const snapshot = structuredClone({ query, replacements, style });
    const plan = planTextReplacements(query, replacements, style);
    assert.deepEqual({ query, replacements, style }, snapshot);
    assert.equal(plan.sourceSha256, query.source.sha256);
    assert.deepEqual(plan.operations, replacements.map(({ from, to }) => ({
      op: 'text.replace', page: query.page, target: query.objects.find(object => object.textSource === from).id,
      expect: { text: from }, value: to, ...style,
    })));
    assert.equal(plan.output, undefined);
    const receipt = await editor.apply({ ...plan, output: path.join(work, 'edited.pdf') });
    assert.equal(receipt.changes.length, 2);
    assert.ok(receipt.validation.reopened);
    assert.ok(receipt.validation.pixelGates.every(gate => gate.changedPixelsOutside === 0));
    await editor.open(receipt.output);
    const after = await editor.query({ type: 'text' });
    for (const operation of plan.operations) {
      const object = after.objects.find(item => item.id === operation.target);
      assert.equal(object.textSource, operation.value);
      assert.equal(object.fontSizeYPt, 10);
      assert.deepEqual(object.fill, { space: 'rendered-rgba', value: [18, 52, 86, 255] });
    }
    plan.operations[0].expect.text = 'mutated';
    assert.deepEqual({ query, replacements, style }, snapshot);
  } finally { await editor.close(); }
});

test('planning aggregates ambiguous, partial and invalid inputs without mutation', () => {
  const text = (id, textSource, editable = true) => ({ id, type: 'text', textSource, editable, supportedOperations: editable ? ['text.replace'] : [] });
  const query = {
    source: { sha256: 'a'.repeat(64) }, page: 0, offset: 1, hasMore: true, matched: 8,
    objects: [text('p0/0', 'Same'), text('p0/1', 'Same'), text('p0/2', 'Locked', false), { id: 'p0/3', type: 'text', editable: true }],
  };
  const replacements = [{ from: 'Same', to: 'Other' }, { from: 'Same', to: 'Again' }, { from: 'Absent', to: 'New' }, { from: 'Locked', to: 'New' }, { from: '', to: 12 }, null];
  const style = { fontSizePt: 0, fill: 'red', target: 'p0/99', op: 'page.crop' };
  const snapshot = structuredClone({ query, replacements, style });
  assert.throws(() => planTextReplacements(query, replacements, style), error => {
    assert.ok(error instanceof PdfError);
    assert.equal(error.code, 'INVALID_ARGUMENT');
    const codes = error.details.issues.map(issue => issue.code);
    for (const code of ['INCOMPLETE_QUERY', 'AMBIGUOUS_TEXT', 'DUPLICATE_REPLACEMENT', 'TEXT_NOT_FOUND', 'TEXT_NOT_EDITABLE', 'MISSING_TEXT_SOURCE', 'INVALID_FROM', 'INVALID_TO', 'INVALID_REPLACEMENT', 'INVALID_FONT_SIZE', 'INVALID_FILL', 'UNKNOWN_STYLE_FIELD']) assert.ok(codes.includes(code), code);
    assert.ok(error.details.issues.every(issue => typeof issue.path === 'string' && typeof issue.message === 'string'));
    return true;
  });
  assert.deepEqual({ query, replacements, style }, snapshot);
  const complete = { source: query.source, page: 0, offset: 0, hasMore: false, matched: 1, objects: [text('p0/0', 'Panel')] };
  assert.throws(() => planTextReplacements(complete, Array(101).fill({ from: 'Panel', to: 'P' })), error => error.details.issues.some(issue => issue.code === 'TOO_MANY_REPLACEMENTS'));
  for (const invalid of [null, [], 'query']) assert.throws(() => planTextReplacements(invalid, null, null), error => error instanceof PdfError && error.details.issues.length >= 3);
  assert.throws(() => planTextReplacements(complete, [{ from: 'Panel', to: 'P', target: 'p0/9' }]), error => error.details.issues.some(issue => issue.code === 'UNKNOWN_REPLACEMENT_FIELD'));
  assert.throws(() => planTextReplacements(complete, Array(1)), error => error.details.issues.some(issue => issue.code === 'INVALID_REPLACEMENT'));
  for (const to of ['', 'x'.repeat(4097), '\uD800', '\uDFFF', '\u{1F600}']) {
    assert.throws(() => planTextReplacements(complete, [{ from: 'Panel', to }]), error => error.details.issues.some(issue => issue.code === 'INVALID_TO'));
  }
  assert.equal(planTextReplacements(complete, [{ from: 'Panel', to: 'x'.repeat(4096) }]).operations[0].value.length, 4096);
});
