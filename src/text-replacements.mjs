import { PdfError } from './engine.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Uniqueness is scoped to textSource values in the supplied query and its filters.
// Unmapped objects cannot establish source-text equality and are never targets.
export function planTextReplacements(queryResult, replacements, style = {}) {
  const issues = [];
  const issue = (code, path, message, details = {}) => issues.push({ code, path, message, ...details });
  const query = record(queryResult) ? queryResult : {};
  if (!record(queryResult)) issue('INVALID_QUERY', 'queryResult', 'Provide a complete query response');
  if (typeof query.source?.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(query.source.sha256)) {
    issue('INVALID_SOURCE', 'queryResult.source.sha256', 'A SHA-256 source fingerprint is required');
  }
  if (!Number.isInteger(query.page) || query.page < 0) issue('INVALID_PAGE', 'queryResult.page', 'A nonnegative query page is required');
  const objects = Array.isArray(query.objects) ? query.objects : [];
  if (!Array.isArray(query.objects)) issue('INVALID_OBJECTS', 'queryResult.objects', 'Query objects must be an array');
  if (query.offset !== 0 || query.hasMore !== false || !Number.isInteger(query.matched) || query.matched !== objects.length) {
    issue('INCOMPLETE_QUERY', 'queryResult', 'Supply all matches with offset 0, hasMore false and matched equal to objects.length');
  }

  const sharedStyle = {};
  if (!record(style)) issue('INVALID_STYLE', 'style', 'Style must be an object');
  else {
    for (const key of Object.keys(style)) {
      if (key !== 'fontSizePt' && key !== 'fill') issue('UNKNOWN_STYLE_FIELD', `style.${key}`, 'Only fontSizePt and fill are supported');
    }
    if (Object.hasOwn(style, 'fontSizePt')) {
      if (!Number.isFinite(style.fontSizePt) || style.fontSizePt <= 0 || style.fontSizePt > 300) {
        issue('INVALID_FONT_SIZE', 'style.fontSizePt', 'Font size must be in (0,300] pt');
      } else sharedStyle.fontSizePt = style.fontSizePt;
    }
    if (Object.hasOwn(style, 'fill')) {
      if (typeof style.fill !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(style.fill)) issue('INVALID_FILL', 'style.fill', 'Color must be #RRGGBB');
      else sharedStyle.fill = style.fill;
    }
  }

  const byText = new Map();
  const ids = new Set();
  Array.from(objects).forEach((object, index) => {
    const objectPath = `queryResult.objects[${index}]`;
    if (!record(object) || typeof object.id !== 'string' || !object.id || typeof object.type !== 'string') {
      issue('INVALID_OBJECT', objectPath, 'Every query object must include id and type');
      return;
    }
    if (ids.has(object.id)) issue('DUPLICATE_OBJECT', `${objectPath}.id`, 'Object IDs must be unique', { target: object.id });
    ids.add(object.id);
    if (object.type !== 'text') return;
    if (typeof object.textSource !== 'string') {
      if (object.editable !== false) issue('MISSING_TEXT_SOURCE', `${objectPath}.textSource`, 'Text objects require textSource; query with mapping enabled and include this field');
      return;
    }
    const matches = byText.get(object.textSource) ?? [];
    matches.push(object);
    byText.set(object.textSource, matches);
  });

  const operations = [];
  if (!Array.isArray(replacements) || !replacements.length) issue('INVALID_REPLACEMENTS', 'replacements', 'Provide 1 to 100 exact text replacements');
  else {
    if (replacements.length > 100) issue('TOO_MANY_REPLACEMENTS', 'replacements', 'A plan accepts at most 100 replacements');
    const seen = new Set();
    Array.from(replacements).forEach((replacement, index) => {
      const replacementPath = `replacements[${index}]`;
      if (!record(replacement)) {
        issue('INVALID_REPLACEMENT', replacementPath, 'Each replacement must contain from and to strings');
        return;
      }
      for (const key of Object.keys(replacement)) {
        if (key !== 'from' && key !== 'to') issue('UNKNOWN_REPLACEMENT_FIELD', `${replacementPath}.${key}`, 'Only from and to are supported');
      }
      const { from, to } = replacement;
      if (typeof to !== 'string' || to.length < 1 || to.length > 4096 || /[\uD800-\uDFFF]/.test(to)) {
        issue('INVALID_TO', `${replacementPath}.to`, 'Replacement text must contain 1 to 4096 UTF-16 code units and BMP characters only');
      }
      if (typeof from !== 'string' || !from.length) {
        issue('INVALID_FROM', `${replacementPath}.from`, 'Source text must be a nonempty exact textSource string');
        return;
      }
      if (seen.has(from)) issue('DUPLICATE_REPLACEMENT', `${replacementPath}.from`, 'Source text is repeated in replacements', { from });
      seen.add(from);
      const matches = byText.get(from) ?? [];
      if (!matches.length) issue('TEXT_NOT_FOUND', replacementPath, 'No complete textSource matches this source text', { from });
      else if (matches.length > 1) issue('AMBIGUOUS_TEXT', replacementPath, 'Source text matches multiple objects', { from, targets: matches.map(object => object.id) });
      else {
        const object = matches[0];
        if (object.editable !== true || !Array.isArray(object.supportedOperations) || !object.supportedOperations.includes('text.replace')) {
          issue('TEXT_NOT_EDITABLE', replacementPath, 'Matching object must be editable and support text.replace', { from, target: object.id });
        } else operations.push({ op: 'text.replace', page: query.page, target: object.id, expect: { text: object.textSource }, value: to, ...sharedStyle });
      }
    });
  }
  if (issues.length) throw new PdfError('INVALID_ARGUMENT', `Cannot plan text replacements: ${issues.length} issue(s)`, { issues });
  return { sourceSha256: query.source.sha256, operations };
}
