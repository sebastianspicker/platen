/**
 * Append one inert text-markup annotation dictionary to a classic passive PDF page.
 */
import { createHash } from 'node:crypto';
import { parsePdfStructure, resolvePdfObject } from '../pdf-classic-structure.mjs';
import {
  planClassicObjectTransaction,
  pendingClassicObjectReference,
} from '../pdf-classic-object-transaction.mjs';
import { pdfDictionary } from '../pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from '../pdf-classic-text-string.mjs';
import { HostError } from '../host-error.mjs';

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function dict(entries) {
  return Object.freeze({ type: 'dict', entries: new Map(entries) });
}
function name(value) {
  return Object.freeze({ type: 'name', value });
}
function number(value) {
  return Object.freeze({ type: 'number', value, integer: Number.isInteger(value), raw: String(value) });
}
function array(values) {
  return Object.freeze({ type: 'array', values: Object.freeze(values) });
}

/**
 * @param {Buffer} sourceBytes classic single-revision PDF
 * @param {{ page?: number, subtype?: string, contents?: string, rect?: number[] }} input
 */
export function writeInertPageAnnotation(sourceBytes, input = {}) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 32) fail('INVALID_SOURCE', 'PDF source bytes required.');
  const subtype = String(input.subtype ?? 'Text');
  const allowed = new Set(['Text', 'Square', 'Circle', 'Highlight', 'Underline', 'StrikeOut', 'Caret', 'FreeText']);
  if (!allowed.has(subtype)) fail('INVALID_SUBTYPE', 'Unsupported inert annotation subtype.');
  const contents = String(input.contents ?? 'Note').slice(0, 500);
  if (!contents.trim()) fail('INVALID_CONTENTS', 'Annotation contents required.');
  const rect = Array.isArray(input.rect) && input.rect.length === 4
    ? input.rect.map(Number)
    : [72, 700, 120, 740];
  if (rect.some((n) => !Number.isFinite(n))) fail('INVALID_RECT', 'rect must be four finite numbers.');

  let structure;
  try {
    structure = parsePdfStructure(sourceBytes);
  } catch {
    fail('UNSUPPORTED_PDF', 'Source is outside the classic annotation subset.', 422);
  }
  if (structure.revisions.length !== 1) fail('UNSUPPORTED_PDF', 'Only single-revision sources admitted.', 422);

  const catalog = pdfDictionary(resolvePdfObject(structure, structure.root).value);
  const pagesRef = catalog.get('Pages');
  if (!pagesRef || pagesRef.type !== 'ref') fail('UNSUPPORTED_PDF', 'Missing pages tree.', 422);
  const pages = pdfDictionary(resolvePdfObject(structure, pagesRef).value);
  const kids = pages.get('Kids');
  if (!kids || kids.type !== 'array' || kids.values.length < 1) fail('UNSUPPORTED_PDF', 'Missing page kids.', 422);
  const pageIndex = Number.isSafeInteger(input.page) ? input.page - 1 : 0;
  if (pageIndex < 0 || pageIndex >= kids.values.length) fail('INVALID_PAGE', 'page out of range.');
  const pageRef = kids.values[pageIndex];
  if (!pageRef || pageRef.type !== 'ref') fail('UNSUPPORTED_PDF', 'Page reference invalid.', 422);

  const pageObj = resolvePdfObject(structure, pageRef);
  const pageEntries = new Map(pdfDictionary(pageObj.value));
  for (const key of ['AA', 'JS', 'JavaScript', 'OpenAction']) {
    if (pageEntries.has(key)) fail('UNSUPPORTED_PDF', 'Active page content rejected.', 422);
  }

  const annotPending = pendingClassicObjectReference('inert-annot');
  const annotValue = dict([
    ['Type', name('Annot')],
    ['Subtype', name(subtype)],
    ['Rect', array(rect.map((n) => number(n)))],
    ['Contents', pdfUtf16BeString(contents)],
    ['F', number(4)],
    ['C', array([number(1), number(1), number(0)])],
    ['P', pageRef],
  ]);

  const existingAnnots = pageEntries.get('Annots');
  if (existingAnnots && existingAnnots.type === 'ref') {
    fail('UNSUPPORTED_PDF', 'Indirect Annots arrays are outside this pure annotation subset.', 422);
  }
  if (existingAnnots && existingAnnots.type === 'array') {
    pageEntries.set('Annots', array([...existingAnnots.values, annotPending]));
  } else if (!existingAnnots) {
    pageEntries.set('Annots', array([annotPending]));
  } else {
    fail('UNSUPPORTED_PDF', 'Unsupported Annots type.', 422);
  }

  let transaction;
  try {
    transaction = planClassicObjectTransaction({
      sourceBytes,
      sourceStructure: structure,
      updates: [{ reference: pageRef, value: dict([...pageEntries.entries()]) }],
      additions: [{ id: 'inert-annot', value: annotValue }],
      info: { kind: 'preserve' },
      changingId: null,
    });
  } catch (error) {
    fail('ANNOTATION_PLAN_FAILED', error?.message ?? 'Could not plan annotation revision.', 502);
  }

  const annotRef = transaction.referencesById?.['inert-annot'];
  if (!annotRef) fail('ANNOTATION_PLAN_FAILED', 'Planner did not allocate annotation reference.', 502);

  const bytes = Buffer.concat([sourceBytes, transaction.revision.bytes]);
  const out = parsePdfStructure(bytes);
  const outPage = pdfDictionary(resolvePdfObject(out, pageRef).value);
  const outAnnots = outPage.get('Annots');
  if (!outAnnots || outAnnots.type !== 'array' || outAnnots.values.length < 1) {
    fail('ANNOTATION_OUTPUT_INVALID', 'Annotation was not attached to page.', 502);
  }
  const last = outAnnots.values[outAnnots.values.length - 1];
  if (last.type !== 'ref') fail('ANNOTATION_OUTPUT_INVALID', 'Annotation ref missing.', 502);
  const annotDict = pdfDictionary(resolvePdfObject(out, last).value);
  if (annotDict.get('Subtype')?.value !== subtype) {
    fail('ANNOTATION_OUTPUT_INVALID', 'Annotation subtype missing in output.', 502);
  }
  const contentsOut = annotDict.get('Contents');
  if (!contentsOut?.bytes?.equals(pdfUtf16BeString(contents).bytes)) {
    fail('ANNOTATION_OUTPUT_INVALID', 'Annotation contents not preserved.', 502);
  }

  return Object.freeze({
    bytes,
    proof: Object.freeze({
      subtype,
      page: pageIndex + 1,
      contentsSha256: createHash('sha256').update(contents).digest('hex'),
      sourcePrefixPreserved: true,
      annotationReference: last,
      outputSha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  });
}
