import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';

export const PDF_ACROFORM_CHECKBOX_PROFILE = 'local-pdf-acroform-checkbox-v1';
export const PDF_ACROFORM_CHECKBOX_STATE_NAME = 'Yes';
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_COORDINATE = 1_000_000;
const PREPARED = new WeakMap();

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'The source PDF is outside the supported passive AcroForm checkbox subset.') { throw failure('UNSUPPORTED_PDF_ACROFORM_CHECKBOX_SOURCE', message); }
function invalid(message = 'The AcroForm checkbox request is invalid.') { throw failure('INVALID_PDF_ACROFORM_CHECKBOX', message); }
function outputInvalid() { throw failure('INVALID_PDF_ACROFORM_CHECKBOX_OUTPUT', 'The AcroForm checkbox output failed deterministic verification.'); }
function ref(object, generation = 0) { return Object.freeze({ type: 'ref', object, generation }); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function number(value, raw = undefined) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), ...(raw ? { raw } : {}) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function sameRef(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function exactObject(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid();
}
function text(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 127 || value !== value.normalize('NFC')
    || /[\u0000-\u001f\u007f\ufffd]/u.test(value) || /[\p{Cf}]/u.test(value)) invalid('fieldName must be bounded NFC text.');
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(index + 1); if (next < 0xdc00 || next > 0xdfff) invalid('fieldName contains an unpaired surrogate.'); index += 1; }
    else if (code >= 0xdc00 && code <= 0xdfff) invalid('fieldName contains an unpaired surrogate.');
  }
  return value;
}
function coordinate(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) invalid(`${field} is outside the bounded coordinate range.`);
  return value;
}
function rect(value) {
  exactObject(value, ['x', 'y', 'width', 'height']);
  const canonical = (input, field) => Math.round(coordinate(input, field) * 1_000_000) / 1_000_000;
  const result = { x: canonical(value.x, 'rect.x'), y: canonical(value.y, 'rect.y'), width: canonical(value.width, 'rect.width'), height: canonical(value.height, 'rect.height') };
  if (result.width <= 0 || result.height <= 0) invalid('rect must have positive dimensions.');
  return Object.freeze(result);
}
function normalizeRequest(source, request) {
  exactObject(request, ['profile', 'sourceSha256', 'page', 'fieldName', 'rect']);
  if (request.profile !== PDF_ACROFORM_CHECKBOX_PROFILE || typeof request.sourceSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(request.sourceSha256) || digest(source) !== request.sourceSha256) invalid('sourceSha256 does not match source bytes.');
  if (!Number.isSafeInteger(request.page) || request.page < 1) invalid('page must be a positive integer.');
  return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName: text(request.fieldName), rect: rect(request.rect) });
}
function numericArray(value, field) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((item) => item?.type !== 'number' || !Number.isFinite(item.value))) unsupported(`${field} must be a direct four-number array.`);
  return value.values.map((item) => item.value);
}
function pageBox(value, field) {
  const [left, bottom, right, top] = numericArray(value, field);
  if (!(right > left && top > bottom) || [left, bottom, right, top].some((item) => Math.abs(item) > MAX_COORDINATE)) unsupported(`${field} is malformed.`);
  return Object.freeze({ left, bottom, right, top });
}
function inside(box, value) { return value.x >= box.left && value.y >= box.bottom && value.x + value.width <= box.right && value.y + value.height <= box.top; }
function formatNumber(value) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) invalid('appearance geometry is outside the bounded range.');
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}
function appearanceBytes(box, on) {
  const width = formatNumber(box.width); const height = formatNumber(box.height);
  const check = on ? `\n0.2 w\n${formatNumber(box.width * 0.2)} ${formatNumber(box.height * 0.52)} m\n${formatNumber(box.width * 0.44)} ${formatNumber(box.height * 0.25)} l\n${formatNumber(box.width * 0.82)} ${formatNumber(box.height * 0.78)} l\nS` : '';
  return Buffer.from(`q\n1 w\n0 0 ${width} ${height} re\nS${check}\nQ\n`, 'latin1');
}
function form(value, streamBytes, box) {
  return { value: dict([['Type', name('XObject')], ['Subtype', name('Form')], ['FormType', number(1)], ['BBox', array([number(0), number(0), number(box.width, formatNumber(box.width)), number(box.height, formatNumber(box.height))])]]), streamBytes };
}
function forbiddenValue(value, context) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'dict') {
    const forbidden = new Set(['AcroForm', 'Annots', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'Outlines', 'PieceInfo', 'Collection', 'OutputIntents', 'XFA', 'Tabs']);
    for (const key of value.entries.keys()) if (forbidden.has(key)) unsupported(`${context} contains unsupported interactive or active content.`);
    if (value.entries.get('Subtype')?.value === 'Widget' || value.entries.get('Type')?.value === 'Sig') unsupported('Existing widgets or signatures are not admitted.');
    for (const [key, child] of value.entries) forbiddenValue(child, `${context}.${key}`);
  } else if (value.type === 'array') for (const child of value.values) forbiddenValue(child, context);
}
function admit(source) {
  if (source.length < 32 || source.length > MAX_SOURCE_BYTES) unsupported('Source size is outside the bounded range.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported('Only valid classic classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1 || structure.revisions.some((revision) => revision.xrefKind === 'stream') || structure.id || structure.info) unsupported('Only one untagged classic revision without IDs or Info is admitted.');
  const catalogObject = resolveClassicPdfObject(structure, structure.root); const catalog = pdfDictionary(catalogObject.value);
  if (catalogObject.stream || catalog.get('Type')?.value !== 'Catalog' || catalog.size !== 2 || catalog.get('Pages')?.type !== 'ref') unsupported('Catalog must be a direct Catalog/Pages pair.');
  const seen = new Set(); const pages = []; const pageDetails = new Map();
  function mark(reference) { const key = `${reference.object}:${reference.generation}`; if (seen.has(key)) unsupported('Aliased page, content, or resource references are not admitted.'); seen.add(key); }
  function markNestedRefs(value) { if (!value || typeof value !== 'object') return; if (value.type === 'ref') { mark(value); return; } if (value.type === 'dict') for (const child of value.entries.values()) markNestedRefs(child); else if (value.type === 'array') for (const child of value.values) markNestedRefs(child); }
  function walk(reference, kind, parent = null) {
    mark(reference); const object = resolveClassicPdfObject(structure, reference); if (object.stream) { if (kind !== 'content') unsupported('Only page content streams may be streams.'); return; }
    const value = pdfDictionary(object.value); forbiddenValue(object.value, `${kind} object`);
    if (kind === 'pages') {
      if (value.get('Type')?.value !== 'Pages' || value.get('Kids')?.type !== 'array' || value.get('Count')?.type !== 'number' || value.get('Count').value < 0 || [...value.keys()].some((key) => !['Type', 'Kids', 'Count'].includes(key))) unsupported('Pages tree is not direct and bounded.');
      for (const child of value.get('Kids').values) { if (child.type !== 'ref') unsupported('Page Kids must be references.'); const childObject = resolveClassicPdfObject(structure, child); const childValue = pdfDictionary(childObject.value); if (childValue.get('Type')?.value === 'Pages') unsupported('Only a flat direct Pages tree is admitted.'); else if (childValue.get('Type')?.value === 'Page') walk(child, 'page', reference); else unsupported('Pages tree contains an unsupported node.'); }
      return;
    }
    if (kind !== 'page') return;
    const allowed = new Set(['Type', 'Parent', 'MediaBox', 'CropBox', 'Resources', 'Contents']);
    if (value.get('Type')?.value !== 'Page' || value.get('Parent')?.type !== 'ref' || !sameRef(value.get('Parent'), parent) || [...value.keys()].some((key) => !allowed.has(key))) unsupported('Page must be direct with no inherited or interactive entries.');
    const media = pageBox(value.get('MediaBox'), 'MediaBox'); const crop = value.has('CropBox') ? pageBox(value.get('CropBox'), 'CropBox') : media;
    if (value.get('Resources')?.type !== 'dict') unsupported('Page Resources must be a direct dictionary.');
    if (value.has('Annots') || value.get('Contents')?.type === 'ref' && seen.has(`${value.get('Contents').object}:${value.get('Contents').generation}`)) unsupported('Page annotations or aliased content are not admitted.');
    const contents = value.get('Contents'); if (contents?.type === 'ref') walk(contents, 'content'); else if (contents?.type === 'array') for (const child of contents.values) { if (child.type !== 'ref') unsupported('Page Contents must be references.'); walk(child, 'content'); }
    forbiddenValue(value.get('Resources'), 'page resources'); markNestedRefs(value.get('Resources')); pages.push(reference); pageDetails.set(`${reference.object}:${reference.generation}`, Object.freeze({ media, crop, value }));
  }
  walk(catalog.get('Pages'), 'pages');
  if (pages.length < 1 || pages.length > MAX_PAGES || pages.length !== pdfDictionary(resolveClassicPdfObject(structure, catalog.get('Pages')).value).get('Count').value) unsupported('Page count is inconsistent or outside bounds.');
  for (const entry of structure.effective.values()) if (entry.status === 'n') { const object = resolveClassicPdfObject(structure, ref(entry.object, entry.generation)); forbiddenValue(object.value, `object ${entry.object}`); const values = object.value?.type === 'dict' ? pdfDictionary(object.value) : null; if (values?.has('T') || values?.get('FT') || values?.get('Subtype')?.value === 'Widget') unsupported('Existing form fields are not admitted.'); }
  return Object.freeze({ structure, pages, pageDetails });
}
function build(source, normalized, admission) {
  const page = admission.pages[normalized.page - 1]; if (!page) invalid('page is outside the direct Pages tree.');
  const detail = admission.pageDetails.get(`${page.object}:${page.generation}`); if (!inside(detail.crop, normalized.rect)) invalid('rect must be fully contained by the page CropBox.');
  const off = pendingClassicObjectReference('off'); const on = pendingClassicObjectReference('on'); const widget = pendingClassicObjectReference('widget'); const acro = pendingClassicObjectReference('acro');
  const offForm = form(null, appearanceBytes(normalized.rect, false), normalized.rect); const onForm = form(null, appearanceBytes(normalized.rect, true), normalized.rect);
  const appearance = dict([['N', dict([['Off', off], [PDF_ACROFORM_CHECKBOX_STATE_NAME, on]])]]);
  const widgetValue = dict([['Type', name('Annot')], ['Subtype', name('Widget')], ['FT', name('Btn')], ['F', number(4)], ['Ff', number(0)], ['T', pdfUtf16BeString(normalized.fieldName)], ['Rect', array([number(normalized.rect.x, formatNumber(normalized.rect.x)), number(normalized.rect.y, formatNumber(normalized.rect.y)), number(normalized.rect.x + normalized.rect.width, formatNumber(normalized.rect.x + normalized.rect.width)), number(normalized.rect.y + normalized.rect.height, formatNumber(normalized.rect.y + normalized.rect.height))])], ['V', name('Off')], ['AS', name('Off')], ['AP', appearance], ['P', page]]);
  const acroValue = dict([['Fields', array([widget])]]);
  const catalogObject = resolveClassicPdfObject(admission.structure, admission.structure.root); const catalogEntries = new Map(pdfDictionary(catalogObject.value)); catalogEntries.set('AcroForm', acro);
  const pageObject = resolveClassicPdfObject(admission.structure, page); const pageEntries = new Map(pdfDictionary(pageObject.value)); pageEntries.set('Annots', array([widget]));
  let transaction; try { transaction = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: admission.structure, updates: [{ reference: admission.structure.root, value: dict(catalogEntries) }, { reference: page, value: dict(pageEntries) }], additions: [{ id: 'off', value: offForm.value, streamBytes: offForm.streamBytes }, { id: 'on', value: onForm.value, streamBytes: onForm.streamBytes }, { id: 'widget', value: widgetValue }, { id: 'acro', value: acroValue }], info: { kind: 'preserve' }, changingId: null }); } catch { unsupported('The checkbox revision could not be planned.'); }
  const bytes = Buffer.concat([source, transaction.revision.bytes]);
  return Object.freeze({ bytes, proof: Object.freeze({ profile: PDF_ACROFORM_CHECKBOX_PROFILE, sourceSha256: normalized.sourceSha256, page: normalized.page, fieldNameSha256: digest(Buffer.from(normalized.fieldName, 'utf8')), rect: normalized.rect, stateName: PDF_ACROFORM_CHECKBOX_STATE_NAME, sourcePrefixPreserved: true, objectCount: 4, references: Object.freeze({ off: transaction.referencesById.off, on: transaction.referencesById.on, widget: transaction.referencesById.widget, acroForm: transaction.referencesById.acro }) }), state: Object.freeze({ source: Buffer.from(source), normalized, admission, references: transaction.referencesById, page, offBytes: offForm.streamBytes, onBytes: onForm.streamBytes }) });
}
function verifyForm(structure, reference, expectedBytes, box) { const object = resolveClassicPdfObject(structure, reference); const actualBytes = object.stream && Number.isSafeInteger(object.streamStart) && Number.isSafeInteger(object.streamLength) ? structure.buffer.subarray(object.streamStart, object.streamStart + object.streamLength) : null; if (!actualBytes?.equals(expectedBytes)) outputInvalid(); const value = pdfDictionary(object.value); const expected = [0, 0, box.width, box.height]; if (value.size !== 5 || value.get('Type')?.value !== 'XObject' || value.get('Subtype')?.value !== 'Form' || value.get('FormType')?.value !== 1 || value.get('Length')?.value !== expectedBytes.length || value.get('Resources') || value.get('BBox')?.type !== 'array' || value.get('BBox').values.some((item, index) => item?.value !== expected[index])) outputInvalid(); }
export function preparePdfAcroFormCheckbox(sourceBytes, request) { if (!Buffer.isBuffer(sourceBytes)) invalid('sourceBytes must be a Buffer.'); const source = Buffer.from(sourceBytes); const normalized = normalizeRequest(source, request); const admission = admit(source); const built = build(source, normalized, admission); const result = Object.freeze({ bytes: built.bytes, proof: built.proof }); PREPARED.set(result, Object.freeze({ ...built.state, proof: built.proof, result })); return result; }
export function inspectPdfAcroFormCheckbox(sourceBytes, outputBytes, request) { const prepared = preparePdfAcroFormCheckbox(sourceBytes, request);
const state = PREPARED.get(prepared);
if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(prepared.bytes) || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) outputInvalid('bytes');
let structure;
try { structure = parseClassicPdfStructure(outputBytes);
} catch { outputInvalid('parse');
} if (structure.revisions.length !== 2) outputInvalid('revisions');
const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value);
if (catalog.size !== 3 || !sameRef(catalog.get('AcroForm'), state.references.acro)) outputInvalid('catalog');
const acro = pdfDictionary(resolveClassicPdfObject(structure, state.references.acro).value);
if (acro.size !== 1 || acro.get('Fields')?.type !== 'array' || acro.get('Fields').values.length !== 1 || !sameRef(acro.get('Fields').values[0], state.references.widget)) outputInvalid('acro');
const page = pdfDictionary(resolveClassicPdfObject(structure, state.page).value);
if (page.get('Annots')?.type !== 'array' || page.get('Annots').values.length !== 1 || !sameRef(page.get('Annots').values[0], state.references.widget)) outputInvalid('page');
const widget = pdfDictionary(resolveClassicPdfObject(structure, state.references.widget).value);
const expectedRect = [state.normalized.rect.x, state.normalized.rect.y, state.normalized.rect.x + state.normalized.rect.width, state.normalized.rect.y + state.normalized.rect.height];
if (widget.size !== 11 || widget.get('Type')?.value !== 'Annot' || widget.get('Subtype')?.value !== 'Widget' || widget.get('FT')?.value !== 'Btn' || widget.get('F')?.value !== 4 || widget.get('Ff')?.value !== 0 || widget.get('V')?.value !== 'Off' || widget.get('AS')?.value !== 'Off' || !sameRef(widget.get('P'), state.page) || widget.get('Rect')?.type !== 'array' || widget.get('Rect').values.some((item, index) => item?.value !== expectedRect[index]) || widget.get('AP')?.type !== 'dict') outputInvalid('widget');
const fieldName = widget.get('T');
if (fieldName?.type !== 'string' || !fieldName.bytes.equals(pdfUtf16BeString(state.normalized.fieldName).bytes)) outputInvalid('name');
const apEntries = pdfDictionary(widget.get('AP'));
if (apEntries.size !== 1) outputInvalid('ap-size');
const normal = pdfDictionary(apEntries.get('N'));
if (normal.size !== 2) outputInvalid('ap-states');
if (!sameRef(normal.get('Off'), state.references.off)) outputInvalid('ap-off');
if (!sameRef(normal.get(PDF_ACROFORM_CHECKBOX_STATE_NAME), state.references.on)) outputInvalid('ap-on');
verifyForm(structure, state.references.off, state.offBytes, state.normalized.rect);
verifyForm(structure, state.references.on, state.onBytes, state.normalized.rect);
return Object.freeze({ ...state.result.proof, otherPagesContentResourcesPreserved: true });
}
export const buildPdfAcroFormCheckbox = preparePdfAcroFormCheckbox;
export const verifyPdfAcroFormCheckbox = inspectPdfAcroFormCheckbox;
