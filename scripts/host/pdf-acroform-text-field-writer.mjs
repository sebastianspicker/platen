import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';

export const PDF_ACROFORM_TEXT_FIELD_PROFILE = 'local-pdf-acroform-text-field-v1';
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_COORDINATE = 1_000_000;
const PREPARED = new WeakMap();

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'The source PDF is outside the supported passive AcroForm text-field subset.') { throw failure('UNSUPPORTED_PDF_ACROFORM_TEXT_FIELD_SOURCE', message); }
function invalid(message = 'The AcroForm text-field request is invalid.') { throw failure('INVALID_PDF_ACROFORM_TEXT_FIELD', message); }
function outputInvalid() { throw failure('INVALID_PDF_ACROFORM_TEXT_FIELD_OUTPUT', 'The AcroForm text-field output failed deterministic verification.'); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function number(value, raw = undefined) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), ...(raw ? { raw } : {}) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function string(value) { return Object.freeze({ type: 'string', bytes: Buffer.from(value, 'latin1') }); }
function sameRef(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactObject(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid();
}

function text(value) {
  if (typeof value !== 'string' || value.length < 1 || Array.from(value).length > 127
    || Buffer.byteLength(value, 'utf8') > 512 || value !== value.normalize('NFC')
    || value.includes('\ufffd') || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) invalid('fieldName must be bounded NFC text without control, format, surrogate, private-use, or unassigned characters.');
  return value;
}
function coordinate(value, field) { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) invalid(`${field} is outside the bounded coordinate range.`); return value; }
function rect(value) {
  exactObject(value, ['x', 'y', 'width', 'height']);
  const canonical = (input, field) => Math.round(coordinate(input, field) * 1_000_000) / 1_000_000;
  const result = { x: canonical(value.x, 'rect.x'), y: canonical(value.y, 'rect.y'), width: canonical(value.width, 'rect.width'), height: canonical(value.height, 'rect.height') };
  if (result.width <= 0 || result.height <= 0) invalid('rect must have positive dimensions.');
  return Object.freeze(result);
}
function normalizeRequest(source, request) {
  exactObject(request, ['profile', 'sourceSha256', 'page', 'fieldName', 'rect']);
  if (request.profile !== PDF_ACROFORM_TEXT_FIELD_PROFILE || typeof request.sourceSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(request.sourceSha256) || digest(source) !== request.sourceSha256) invalid('sourceSha256 does not match source bytes.');
  if (!Number.isSafeInteger(request.page) || request.page < 1) invalid('page must be a positive integer.');
  return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName: text(request.fieldName), rect: rect(request.rect) });
}
function numericArray(value, field) { if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((item) => item?.type !== 'number' || !Number.isFinite(item.value))) unsupported(`${field} must be a direct four-number array.`); return value.values.map((item) => item.value); }
function pageBox(value, field) { const [left, bottom, right, top] = numericArray(value, field); if (!(right > left && top > bottom) || [left, bottom, right, top].some((item) => Math.abs(item) > MAX_COORDINATE)) unsupported(`${field} is malformed.`); return Object.freeze({ left, bottom, right, top }); }
function inside(box, value) { return value.x >= box.left && value.y >= box.bottom && value.x + value.width <= box.right && value.y + value.height <= box.top; }
function formatNumber(value) { if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) invalid('appearance geometry is outside the bounded range.'); const rounded = Math.round(value * 1_000_000) / 1_000_000; return Object.is(rounded, -0) ? '0' : String(rounded); }
function appearanceBytes(box) { return Buffer.from(`q\n1 w\n0 0 ${formatNumber(box.width)} ${formatNumber(box.height)} re\nS\nQ\n`, 'latin1'); }
function form(streamBytes, box) { return { value: dict([['Type', name('XObject')], ['Subtype', name('Form')], ['FormType', number(1)], ['BBox', array([number(0), number(0), number(box.width, formatNumber(box.width)), number(box.height, formatNumber(box.height))])]]), streamBytes }; }

function forbiddenValue(value, context) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'dict') {
    const forbidden = new Set(['AcroForm', 'Annots', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'Outlines', 'PieceInfo', 'Collection', 'OutputIntents', 'XFA', 'Tabs', 'OC', 'Layer', 'Group', 'URI', 'Dest', 'GoTo', 'Launch', 'SubmitForm', 'ResetForm', 'NeedAppearances', 'CO', 'DR', 'ByteRange', 'SubFilter', 'Cert', 'Reference', 'TransformMethod', 'RoleMap', 'ParentTree']);
    for (const key of value.entries.keys()) if (forbidden.has(key)) unsupported(`${context} contains unsupported interactive, tagged, or layered content.`);
    if (value.entries.get('Subtype')?.value === 'Widget' || value.entries.get('Type')?.value === 'Sig' || value.entries.get('FT')?.value === 'Sig') unsupported('Existing widgets or signatures are not admitted.');
    for (const [key, child] of value.entries) forbiddenValue(child, `${context}.${key}`);
  } else if (value.type === 'array') for (const child of value.values) forbiddenValue(child, context);
}
function admit(source) {
  if (source.length < 32 || source.length > MAX_SOURCE_BYTES) unsupported('Source size is outside the bounded range.');
  if (source.includes(Buffer.from('/Encrypt', 'latin1'))) unsupported('Encrypted PDFs are not admitted.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported('Only valid classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1 || structure.revisions.some((revision) => revision.xrefKind === 'stream') || structure.id || structure.info) unsupported('Only one untagged classic revision without IDs or Info is admitted.');
  const catalogObject = resolveClassicPdfObject(structure, structure.root); const catalog = pdfDictionary(catalogObject.value);
  if (catalogObject.stream || catalog.get('Type')?.value !== 'Catalog' || catalog.size !== 2 || catalog.get('Pages')?.type !== 'ref') unsupported('Catalog must be a direct Catalog/Pages pair.');
  forbiddenValue(catalogObject.value, 'catalog');
  const seen = new Set(); const pages = []; const pageDetails = new Map();
  function mark(reference) { const key = `${reference.object}:${reference.generation}`; if (seen.has(key)) unsupported('Aliased page, content, or resource references are not admitted.'); seen.add(key); }
  function markNestedRefs(value) { if (!value || typeof value !== 'object') return; if (value.type === 'ref') { mark(value); return; } if (value.type === 'dict') for (const child of value.entries.values()) markNestedRefs(child); else if (value.type === 'array') for (const child of value.values) markNestedRefs(child); }
  function walk(reference, kind, parent = null) {
    mark(reference); const object = resolveClassicPdfObject(structure, reference); if (object.stream) { if (kind !== 'content') unsupported('Only page content streams may be streams.'); return; }
    const value = pdfDictionary(object.value); forbiddenValue(object.value, `${kind} object`);
    if (kind === 'pages') { if (value.get('Type')?.value !== 'Pages' || value.get('Kids')?.type !== 'array' || value.get('Count')?.type !== 'number' || value.get('Count').value < 0 || [...value.keys()].some((key) => !['Type', 'Kids', 'Count'].includes(key))) unsupported('Pages tree is not direct and bounded.'); for (const child of value.get('Kids').values) { if (child.type !== 'ref') unsupported('Page Kids must be references.'); const childValue = pdfDictionary(resolveClassicPdfObject(structure, child).value); if (childValue.get('Type')?.value === 'Pages') unsupported('Only a flat direct Pages tree is admitted.'); else if (childValue.get('Type')?.value === 'Page') walk(child, 'page', reference); else unsupported('Pages tree contains an unsupported node.'); } return; }
    if (kind !== 'page') return;
    const allowed = new Set(['Type', 'Parent', 'MediaBox', 'CropBox', 'Resources', 'Contents']);
    if (value.get('Type')?.value !== 'Page' || value.get('Parent')?.type !== 'ref' || !sameRef(value.get('Parent'), parent) || [...value.keys()].some((key) => !allowed.has(key))) unsupported('Page must be direct with no inherited or interactive entries.');
    const media = pageBox(value.get('MediaBox'), 'MediaBox'); const crop = value.has('CropBox') ? pageBox(value.get('CropBox'), 'CropBox') : media;
    if (value.get('Resources')?.type !== 'dict') unsupported('Page Resources must be a direct dictionary.');
    if (value.has('Annots')) unsupported('Existing annotations or widgets are not admitted.');
    const contents = value.get('Contents'); if (contents?.type === 'ref') walk(contents, 'content'); else if (contents?.type === 'array') for (const child of contents.values) { if (child.type !== 'ref') unsupported('Page Contents must be references.'); walk(child, 'content'); } else if (contents !== undefined) unsupported('Page Contents must be a reference or array.');
    forbiddenValue(value.get('Resources'), 'page resources'); markNestedRefs(value.get('Resources')); pages.push(reference); pageDetails.set(`${reference.object}:${reference.generation}`, Object.freeze({ media, crop }));
  }
  walk(catalog.get('Pages'), 'pages');
  if (pages.length < 1 || pages.length > MAX_PAGES || pages.length !== pdfDictionary(resolveClassicPdfObject(structure, catalog.get('Pages')).value).get('Count').value) unsupported('Page count is inconsistent or outside bounds.');
  for (const entry of structure.effective.values()) if (entry.status === 'n') { const object = resolveClassicPdfObject(structure, { type: 'ref', object: entry.object, generation: entry.generation }); forbiddenValue(object.value, `object ${entry.object}`); const values = object.value?.type === 'dict' ? pdfDictionary(object.value) : null; if (values?.has('T') || values?.get('FT') || values?.get('Subtype')?.value === 'Widget' || values?.has('AA') || values?.has('A')) unsupported('Existing form fields or actions are not admitted.'); }
  return Object.freeze({ structure, pages, pageDetails });
}

function build(source, normalized, admission) {
  const page = admission.pages[normalized.page - 1]; if (!page) invalid('page is outside the direct Pages tree.');
  const detail = admission.pageDetails.get(`${page.object}:${page.generation}`); if (!inside(detail.crop, normalized.rect)) invalid('rect must be fully contained by the page CropBox.');
  const appearanceRef = pendingClassicObjectReference('appearance'); const fontRef = pendingClassicObjectReference('font'); const widget = pendingClassicObjectReference('widget'); const acro = pendingClassicObjectReference('acro');
  const appearanceForm = form(appearanceBytes(normalized.rect), normalized.rect);
  const widgetValue = dict([['Type', name('Annot')], ['Subtype', name('Widget')], ['FT', name('Tx')], ['F', number(4)], ['Ff', number(0)], ['T', pdfUtf16BeString(normalized.fieldName)], ['Rect', array([number(normalized.rect.x, formatNumber(normalized.rect.x)), number(normalized.rect.y, formatNumber(normalized.rect.y)), number(normalized.rect.x + normalized.rect.width, formatNumber(normalized.rect.x + normalized.rect.width)), number(normalized.rect.y + normalized.rect.height, formatNumber(normalized.rect.y + normalized.rect.height))])], ['V', pdfUtf16BeString('')], ['DA', string('/Helv 12 Tf 0 g')], ['AP', dict([['N', appearanceRef]])], ['P', page]]);
  const acroValue = dict([['DA', string('/Helv 12 Tf 0 g')], ['DR', dict([['Font', dict([['Helv', fontRef]])]])], ['Fields', array([widget])]]);
  const fontValue = dict([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')]]);
  const catalogObject = resolveClassicPdfObject(admission.structure, admission.structure.root); const catalogEntries = new Map(pdfDictionary(catalogObject.value)); catalogEntries.set('AcroForm', acro);
  const pageObject = resolveClassicPdfObject(admission.structure, page); const pageEntries = new Map(pdfDictionary(pageObject.value)); pageEntries.set('Annots', array([widget]));
  let transaction; try { transaction = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: admission.structure, updates: [{ reference: admission.structure.root, value: dict(catalogEntries) }, { reference: page, value: dict(pageEntries) }], additions: [{ id: 'appearance', value: appearanceForm.value, streamBytes: appearanceForm.streamBytes }, { id: 'font', value: fontValue }, { id: 'widget', value: widgetValue }, { id: 'acro', value: acroValue }], info: { kind: 'preserve' }, changingId: null }); } catch { unsupported('The text-field revision could not be planned.'); }
  const bytes = Buffer.concat([source, transaction.revision.bytes]);
  const references = Object.freeze({ appearance: transaction.referencesById.appearance, font: transaction.referencesById.font, widget: transaction.referencesById.widget, acroForm: transaction.referencesById.acro });
  return Object.freeze({ bytes, proof: Object.freeze({ profile: PDF_ACROFORM_TEXT_FIELD_PROFILE, sourceSha256: normalized.sourceSha256, page: normalized.page, fieldNameSha256: digest(Buffer.from(normalized.fieldName, 'utf8')), rect: normalized.rect, sourcePrefixPreserved: true, defaultEmpty: true, objectCount: 4, references }), state: Object.freeze({ normalized, admission, references, page, appearanceBytes: appearanceForm.streamBytes }) });
}

export function preparePdfAcroFormTextField(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes)) invalid('sourceBytes must be a Buffer.');
  const source = Buffer.from(sourceBytes); const normalized = normalizeRequest(source, request); const admission = admit(source); const built = build(source, normalized, admission); const result = Object.freeze({ bytes: built.bytes, proof: built.proof }); PREPARED.set(result, Object.freeze({ ...built.state, proof: built.proof, result })); return result;
}
export function inspectPdfAcroFormTextField(sourceBytes, outputBytes, request) {
  const prepared = preparePdfAcroFormTextField(sourceBytes, request); const state = PREPARED.get(prepared);
  if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(prepared.bytes) || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) outputInvalid();
  let structure; try { structure = parseClassicPdfStructure(outputBytes); } catch { outputInvalid(); }
  if (structure.revisions.length !== 2) outputInvalid();
  const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value); if (catalog.size !== 3 || !sameRef(catalog.get('AcroForm'), state.references.acroForm)) outputInvalid();
  const acro = pdfDictionary(resolveClassicPdfObject(structure, state.references.acroForm).value); if (acro.size !== 3 || !acro.get('DA')?.bytes?.equals(Buffer.from('/Helv 12 Tf 0 g', 'latin1')) || acro.get('DR')?.type !== 'dict' || acro.get('DR').entries.size !== 1 || acro.get('DR').entries.get('Font')?.type !== 'dict' || acro.get('DR').entries.get('Font').entries.size !== 1 || !sameRef(acro.get('DR').entries.get('Font').entries.get('Helv'), state.references.font) || acro.get('Fields')?.type !== 'array' || acro.get('Fields').values.length !== 1 || !sameRef(acro.get('Fields').values[0], state.references.widget)) outputInvalid();
  const font = pdfDictionary(resolveClassicPdfObject(structure, state.references.font).value); if (font.size !== 3 || font.get('Type')?.value !== 'Font' || font.get('Subtype')?.value !== 'Type1' || font.get('BaseFont')?.value !== 'Helvetica') outputInvalid();
  const page = pdfDictionary(resolveClassicPdfObject(structure, state.page).value); if (page.get('Annots')?.type !== 'array' || page.get('Annots').values.length !== 1 || !sameRef(page.get('Annots').values[0], state.references.widget)) outputInvalid();
  const widget = pdfDictionary(resolveClassicPdfObject(structure, state.references.widget).value); const expectedRect = [state.normalized.rect.x, state.normalized.rect.y, state.normalized.rect.x + state.normalized.rect.width, state.normalized.rect.y + state.normalized.rect.height];
  if (widget.size !== 11 || widget.get('Type')?.value !== 'Annot' || widget.get('Subtype')?.value !== 'Widget' || widget.get('FT')?.value !== 'Tx' || widget.get('F')?.value !== 4 || widget.get('Ff')?.value !== 0 || !sameRef(widget.get('P'), state.page) || widget.get('Rect')?.type !== 'array' || widget.get('Rect').values.some((item, index) => item?.value !== expectedRect[index]) || widget.get('V')?.type !== 'string' || widget.get('V').bytes.length !== 2 || !widget.get('DA')?.bytes?.equals(Buffer.from('/Helv 12 Tf 0 g', 'latin1')) || widget.get('AP')?.type !== 'dict') outputInvalid();
  if (widget.get('T')?.type !== 'string' || !widget.get('T').bytes.equals(pdfUtf16BeString(state.normalized.fieldName).bytes)) outputInvalid();
  const normal = pdfDictionary(widget.get('AP')).get('N'); if (!sameRef(normal, state.references.appearance)) outputInvalid();
  const appearance = resolveClassicPdfObject(structure, state.references.appearance); const appearanceValue = pdfDictionary(appearance.value); const bytes = appearance.stream && structure.buffer.subarray(appearance.streamStart, appearance.streamStart + appearance.streamLength);
  if (!bytes?.equals(state.appearanceBytes) || appearanceValue.size !== 5 || appearanceValue.get('Type')?.value !== 'XObject' || appearanceValue.get('Subtype')?.value !== 'Form' || appearanceValue.get('FormType')?.value !== 1 || appearanceValue.get('Length')?.value !== state.appearanceBytes.length || appearanceValue.has('Resources') || appearanceValue.get('BBox')?.values.some((item, index) => item?.value !== [0, 0, state.normalized.rect.width, state.normalized.rect.height][index])) outputInvalid();
  return Object.freeze({ ...state.result.proof, otherPagesContentResourcesPreserved: true });
}
export const buildPdfAcroFormTextField = preparePdfAcroFormTextField;
export const verifyPdfAcroFormTextField = inspectPdfAcroFormTextField;
