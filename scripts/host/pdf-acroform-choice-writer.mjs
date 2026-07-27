import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';

export const PDF_ACROFORM_CHOICE_PROFILE = 'local-pdf-acroform-choice-v1';
const MAX_SOURCE = 32 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_OPTIONS = 50;
const MAX_COORDINATE = 1_000_000;

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function invalid(message = 'The AcroForm choice request is invalid.') { throw failure('INVALID_PDF_ACROFORM_CHOICE', message); }
function unsupported(message = 'The source PDF is outside the supported passive AcroForm choice subset.') { throw failure('UNSUPPORTED_PDF_ACROFORM_CHOICE_SOURCE', message); }
function outputInvalid(message = 'The AcroForm choice output failed deterministic verification.') { throw failure('INVALID_PDF_ACROFORM_CHOICE_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function number(value, raw) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), ...(raw ? { raw } : {}) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dictionary(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function same(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function reference(object, generation = 0) { return { type: 'ref', object, generation }; }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || Object.keys(descriptors).some((key) => !keys.includes(key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid();
}
function text(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 127 || value !== value.normalize('NFC')
    || /[\u0000-\u001f\u007f\ufffd]/u.test(value) || /[\p{Cf}]/u.test(value)) invalid(`${label} must be bounded NFC text.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index); const next = value.charCodeAt(index + 1);
    if ((code >= 0xd800 && code <= 0xdbff) && !(next >= 0xdc00 && next <= 0xdfff)) invalid(`${label} contains an unpaired surrogate.`);
    if (code >= 0xdc00 && code <= 0xdfff) invalid(`${label} contains an unpaired surrogate.`);
  }
  return value;
}
function rectangle(value) {
  exact(value, ['x', 'y', 'width', 'height']);
  const round = (item) => Math.round(item * 1e6) / 1e6;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, round(item)]));
  if (Object.values(result).some((item) => typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > MAX_COORDINATE)
    || result.width <= 0 || result.height <= 0 || Math.abs(result.x + result.width) > MAX_COORDINATE || Math.abs(result.y + result.height) > MAX_COORDINATE) invalid('rect is outside the bounded geometry.');
  return Object.freeze(result);
}
function normalize(source, request) {
  exact(request, ['profile', 'sourceSha256', 'page', 'fieldName', 'rect', 'options']);
  if (request.profile !== PDF_ACROFORM_CHOICE_PROFILE || !/^[0-9a-f]{64}$/u.test(request.sourceSha256)
    || digest(source) !== request.sourceSha256 || !Number.isSafeInteger(request.page) || request.page < 1) invalid();
  const fieldName = text(request.fieldName, 'fieldName');
  if (!Array.isArray(request.options) || request.options.length < 2 || request.options.length > MAX_OPTIONS) invalid('options must contain 2 through 50 labels.');
  const seen = new Set();
  const options = request.options.map((entry, index) => {
    exact(entry, ['label']); const label = text(entry.label, `options[${index}].label`);
    if (seen.has(label)) invalid('option labels must be unique.'); seen.add(label); return label;
  });
  return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName, rect: rectangle(request.rect), options: Object.freeze(options) });
}
function rejectForbidden(value, context) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'dict') {
    const forbidden = new Set(['AcroForm', 'Annots', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'Outlines', 'PieceInfo', 'Collection', 'OutputIntents', 'XFA', 'Tabs']);
    for (const key of value.entries.keys()) if (forbidden.has(key)) unsupported(`${context} contains active content.`);
    if (value.entries.get('Subtype')?.value === 'Widget' || value.entries.get('Type')?.value === 'Sig') unsupported('Existing forms or signatures are not admitted.');
    for (const [key, child] of value.entries) rejectForbidden(child, `${context}.${key}`);
  } else if (value.type === 'array') for (const child of value.values) rejectForbidden(child, context);
}
function pageBox(value) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry?.type !== 'number' || !Number.isFinite(entry.value))) unsupported('Page geometry is malformed.');
  const [left, bottom, right, top] = value.values.map((entry) => entry.value);
  if (!(right > left && top > bottom)) unsupported('Page geometry has non-positive dimensions.');
  return { left, bottom, right, top };
}
function admit(source) {
  if (source.length < 32 || source.length > MAX_SOURCE || source.includes(Buffer.from('/Encrypt', 'latin1'))) unsupported('Source is encrypted or oversized.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported('Malformed classic PDF.'); }
  if (structure.revisions.length !== 1 || structure.revisions.some((revision) => revision.xrefKind === 'stream') || structure.id || structure.info) unsupported('Only one unsigned classic revision is admitted.');
  const catalogObject = resolveClassicPdfObject(structure, structure.root); const catalog = pdfDictionary(catalogObject.value);
  if (catalogObject.stream || catalog.size !== 2 || catalog.get('Type')?.value !== 'Catalog' || catalog.get('Pages')?.type !== 'ref') unsupported('Catalog is outside the passive subset.');
  const pages = []; const seen = new Set();
  const walk = (ref, parent) => {
    const key = `${ref.object}:${ref.generation}`; if (seen.has(key)) unsupported('Aliased page graph.'); seen.add(key);
    const object = resolveClassicPdfObject(structure, ref); if (object.stream) unsupported(); const value = pdfDictionary(object.value); rejectForbidden(object.value, 'page graph');
    if (value.get('Type')?.value === 'Pages') {
      if (value.size !== 3 || value.get('Kids')?.type !== 'array' || value.get('Count')?.value !== value.get('Kids').values.length) unsupported('Pages tree is not flat.');
      for (const child of value.get('Kids').values) { if (child.type !== 'ref') unsupported(); walk(child, ref); } return;
    }
    if (value.get('Type')?.value !== 'Page' || !same(value.get('Parent'), parent) || value.get('Resources')?.type !== 'dict' || value.has('Annots')) unsupported('Page contains unsupported structures.');
    pageBox(value.get('MediaBox')); pages.push(ref);
  };
  walk(catalog.get('Pages'), null); if (pages.length < 1 || pages.length > MAX_PAGES) unsupported('Page count is outside the bound.');
  for (const entry of structure.effective.values()) if (entry.status === 'n') rejectForbidden(resolveClassicPdfObject(structure, reference(entry.object, entry.generation)).value, 'source object');
  return Object.freeze({ structure, pages });
}
function appearance(rect, font) {
  const bytes = Buffer.from(`q\n0.5 w\n0 0 ${rect.width} ${rect.height} re\nS\nQ\n`, 'latin1');
  const value = dictionary([['Type', name('XObject')], ['Subtype', name('Form')], ['FormType', number(1)], ['BBox', array([number(0), number(0), number(rect.width), number(rect.height)])], ['Resources', dictionary([['Font', dictionary([['Helv', font]])]])]]);
  return { value, bytes };
}
function build(source, normalized, admission) {
  const page = admission.pages[normalized.page - 1]; if (!page) invalid('page is outside the document.');
  const pageValue = pdfDictionary(resolveClassicPdfObject(admission.structure, page).value); const crop = pageBox(pageValue.get('CropBox') ?? pageValue.get('MediaBox'));
  if (normalized.rect.x < crop.left || normalized.rect.y < crop.bottom || normalized.rect.x + normalized.rect.width > crop.right || normalized.rect.y + normalized.rect.height > crop.top) invalid('rect must be inside CropBox.');
  const font = pendingClassicObjectReference('font'); const appearanceRef = pendingClassicObjectReference('appearance'); const widget = pendingClassicObjectReference('widget'); const acro = pendingClassicObjectReference('acro');
  const app = appearance(normalized.rect, font); const labels = array(normalized.options.map((label) => pdfUtf16BeString(label))); const da = pdfUtf16BeString('/Helv 10 Tf 0 g');
  const widgetValue = dictionary([['Type', name('Annot')], ['Subtype', name('Widget')], ['FT', name('Ch')], ['F', number(4)], ['Ff', number(0)], ['T', pdfUtf16BeString(normalized.fieldName)], ['Rect', array([number(normalized.rect.x), number(normalized.rect.y), number(normalized.rect.x + normalized.rect.width), number(normalized.rect.y + normalized.rect.height)])], ['Opt', labels], ['DA', da], ['DR', dictionary([['Font', dictionary([['Helv', font]])]])], ['AP', dictionary([['N', appearanceRef]])], ['P', page]]);
  const acroValue = dictionary([['Fields', array([widget])], ['DR', dictionary([['Font', dictionary([['Helv', font]])]])], ['DA', da]]);
  const catalog = resolveClassicPdfObject(admission.structure, admission.structure.root); const catalogEntries = new Map(pdfDictionary(catalog.value)); catalogEntries.set('AcroForm', acro); const pageEntries = new Map(pageValue); pageEntries.set('Annots', array([widget]));
  const transaction = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: admission.structure, updates: [{ reference: admission.structure.root, value: dictionary(catalogEntries) }, { reference: page, value: dictionary(pageEntries) }], additions: [{ id: 'font', value: dictionary([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')], ['Encoding', name('WinAnsiEncoding')]]) }, { id: 'appearance', value: app.value, streamBytes: app.bytes }, { id: 'widget', value: widgetValue }, { id: 'acro', value: acroValue }], info: { kind: 'preserve' }, changingId: null });
  return { bytes: Buffer.concat([source, transaction.revision.bytes]), refs: transaction.referencesById, appearanceBytes: app.bytes };
}
export function preparePdfAcroFormChoice(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes)) invalid('sourceBytes must be a Buffer.'); const source = Buffer.from(sourceBytes); const normalized = normalize(source, request); const admission = admit(source); const built = build(source, normalized, admission);
  const proof = Object.freeze({ profile: PDF_ACROFORM_CHOICE_PROFILE, sourceSha256: normalized.sourceSha256, page: normalized.page, fieldNameSha256: digest(Buffer.from(normalized.fieldName, 'utf8')), optionLabelSha256: Object.freeze(normalized.options.map((label) => digest(Buffer.from(label, 'utf8')))), rect: normalized.rect, options: Object.freeze(normalized.options.map((label) => Object.freeze({ labelSha256: digest(Buffer.from(label, 'utf8')) }))), combo: false, font: built.refs.font, appearance: built.refs.appearance, widget: built.refs.widget, acroForm: built.refs.acro, sourcePrefixPreserved: true, appearanceSha256: digest(built.appearanceBytes) });
  return Object.freeze({ bytes: built.bytes, proof });
}
export function inspectPdfAcroFormChoice(sourceBytes, outputBytes, request) {
  const prepared = preparePdfAcroFormChoice(sourceBytes, request); if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(prepared.bytes) || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) outputInvalid();
  let structure; try { structure = parseClassicPdfStructure(outputBytes); } catch { outputInvalid(); } if (structure.revisions.length !== 2) outputInvalid();
  const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value); if (!same(catalog.get('AcroForm'), prepared.proof.acroForm)) outputInvalid();
  const acro = pdfDictionary(resolveClassicPdfObject(structure, prepared.proof.acroForm).value); const widget = pdfDictionary(resolveClassicPdfObject(structure, prepared.proof.widget).value); const font = pdfDictionary(resolveClassicPdfObject(structure, prepared.proof.font).value); const pageRef = admit(Buffer.from(sourceBytes)).pages[prepared.proof.page - 1]; const page = pdfDictionary(resolveClassicPdfObject(structure, pageRef).value);
  const expectedRect = [prepared.proof.rect.x, prepared.proof.rect.y, prepared.proof.rect.x + prepared.proof.rect.width, prepared.proof.rect.y + prepared.proof.rect.height];
  if (acro.get('DA')?.type !== 'string' || !acro.get('DA').bytes.equals(pdfUtf16BeString('/Helv 10 Tf 0 g').bytes)) outputInvalid();
  if (widget.get('DA')?.type !== 'string' || !widget.get('DA').bytes.equals(pdfUtf16BeString('/Helv 10 Tf 0 g').bytes)) outputInvalid();
  if (acro.get('Fields')?.type !== 'array' || acro.get('Fields').values.length !== 1 || !same(acro.get('Fields').values[0], prepared.proof.widget) || widget.get('FT')?.value !== 'Ch' || widget.get('Ff')?.value !== 0 || widget.has('V') || widget.has('DV') || widget.get('Opt')?.type !== 'array' || widget.get('Opt').values.length !== prepared.proof.options.length || widget.get('Opt').values.some((entry, index) => entry?.type !== 'string' || !entry.bytes.equals(pdfUtf16BeString(request.options[index].label).bytes)) || widget.get('Rect')?.values.some((entry, index) => entry.value !== expectedRect[index]) || !same(widget.get('P'), pageRef) || font.get('Subtype')?.value !== 'Type1' || font.get('BaseFont')?.value !== 'Helvetica' || font.get('Encoding')?.value !== 'WinAnsiEncoding' || page.get('Annots')?.type !== 'array' || page.get('Annots').values.filter((entry) => same(entry, prepared.proof.widget)).length !== 1) outputInvalid();
  const appearance = resolveClassicPdfObject(structure, prepared.proof.appearance); const bytes = appearance.stream ? structure.buffer.subarray(appearance.streamStart, appearance.streamStart + appearance.streamLength) : null; if (!bytes || digest(bytes) !== prepared.proof.appearanceSha256) outputInvalid();
  return prepared.proof;
}
export const buildPdfAcroFormChoice = preparePdfAcroFormChoice;
export const verifyPdfAcroFormChoice = inspectPdfAcroFormChoice;
