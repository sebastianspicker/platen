import { MAX_PAGE, MAX_RECORDS, MAX_TEXT, fail, integer } from './review-forms-validation.mjs';

export function detectFields(text, { page = 1 } = {}) {
  const invalidText = typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT
    || /\u0000/.test(text);
  if (invalidText) fail('INVALID_INPUT', 'text must be bounded label content.');
  integer(page, 'page', 1, MAX_PAGE);
  const labels = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 50);
  return labels.flatMap((label, index) => {
    const clean = label.replace(/[:*]+$/, '').trim();
    if (!clean || clean.length > 128) return [];
    const lower = clean.toLowerCase();
    let type = null;
    if (/date/.test(lower)) type = 'date';
    else if (/email|name|address|comment|phone/.test(lower)) type = 'text';
    else if (/amount|quantity|total|number/.test(lower)) type = 'number';
    else if (/agree|consent|accept/.test(lower)) type = 'checkbox';
    if (!type) return [];
    return [{
      name: clean.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || `field_${index + 1}`,
      type,
      page,
      rectangle: [36, 700 - index * 18, 280, 714 - index * 18],
      tabOrder: index,
      tooltip: clean,
      required: /\*$/.test(label),
      defaultValue: type === 'checkbox' ? false : '',
      options: [],
      validation: { pattern: '' },
      calculation: '',
    }];
  });
}

export function staticToFillable(workspace, createField, documentId, definitions, options = {}) {
  if (!Array.isArray(definitions) || definitions.length > MAX_RECORDS) {
    fail('INVALID_FIELDS', 'definitions must be a bounded array.');
  }
  let revision = options.expectedRevision;
  let result;
  for (const definition of definitions) {
    result = createField(documentId, definition, { expectedRevision: revision });
    revision = result.revision;
  }
  return result ?? workspace.snapshot(documentId);
}
