import { createHash } from 'node:crypto';
import {
  parseClassicPdfStructure,
  resolveClassicPdfObject,
} from './pdf-classic-structure.mjs';
import {
  pdfDictionary,
  serializePdfValue,
} from './pdf-classic-syntax.mjs';
import {
  buildClassicIncrementalRevision,
  verifyClassicIncrementalRevision,
} from './pdf-classic-incremental-revision.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';

export const PDF_SIGNATURE_CONTAINER_PROFILE = 'local-pdf-signature-container-v1';
const MIN_PLACEHOLDER = 4096;
const MAX_PLACEHOLDER = 262144;
const BYTE_RANGE_WIDTH = 10;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 10_000;
const PREPARED = new WeakMap();
const FINAL = new WeakMap();

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'The source PDF is outside the supported passive signature-container subset.') {
  throw failure('UNSUPPORTED_PDF_SIGNATURE_CONTAINER_SOURCE', message);
}
function invalid(message = 'The PDF signature-container request is invalid.') {
  throw failure('INVALID_PDF_SIGNATURE_CONTAINER', message);
}
function outputInvalid() { throw failure('INVALID_PDF_SIGNATURE_CONTAINER_OUTPUT', 'The PDF signature-container output failed deterministic verification.'); }
function ref(object, generation = 0) { return Object.freeze({ type: 'ref', object, generation }); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function number(value, raw = undefined) { return Object.freeze({ type: 'number', value, integer: true, ...(raw ? { raw } : {}) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function sameRef(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactObject(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid();
  const actual = Object.keys(descriptors).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) invalid();
}

function printableNfc(value, field, min, max) {
  if (typeof value !== 'string' || value !== value.normalize('NFC')) invalid(`${field} must be NFC-normalized text.`);
  if (value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${field} contains unsupported control text.`);
  for (const character of value) if (character === '\ufffd') invalid(`${field} contains an invalid replacement character.`);
  return value;
}

function normalizeRequest(request, source) {
  exactObject(request, ['profile', 'sourceSha256', 'page', 'fieldName', 'reason', 'location', 'contact', 'placeholderBytes']);
  if (request.profile !== PDF_SIGNATURE_CONTAINER_PROFILE || typeof request.sourceSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(request.sourceSha256) || request.sourceSha256 !== digest(source)) invalid('sourceSha256 does not match the source bytes.');
  if (!Number.isSafeInteger(request.page) || request.page < 1) invalid('page must be a positive integer.');
  const fieldName = printableNfc(request.fieldName, 'fieldName', 1, 127);
  const reason = printableNfc(request.reason, 'reason', 0, 255);
  const location = printableNfc(request.location, 'location', 0, 255);
  const contact = printableNfc(request.contact, 'contact', 0, 255);
  if (!Number.isSafeInteger(request.placeholderBytes) || request.placeholderBytes < MIN_PLACEHOLDER || request.placeholderBytes > MAX_PLACEHOLDER) invalid('placeholderBytes is outside the bounded range.');
  return Object.freeze({ profile: PDF_SIGNATURE_CONTAINER_PROFILE, sourceSha256: request.sourceSha256, page: request.page, fieldName, reason, location, contact, placeholderBytes: request.placeholderBytes });
}

function rejectKeys(entries, forbidden, context) {
  for (const key of entries.keys()) if (forbidden.has(key)) unsupported(`${context} contains unsupported ${key}.`);
}
function rejectUnexpected(entries, allowed, context) {
  for (const key of entries.keys()) if (!allowed.has(key)) unsupported(`${context} contains unsupported ${key}.`);
}

function inspectValue(structure, value, state, context = 'object') {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'dict') {
    rejectKeys(value.entries, new Set(['AcroForm', 'Sig', 'ByteRange', 'SubFilter', 'Widget', 'FT', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'Outlines', 'PieceInfo', 'Collection', 'OutputIntents']), context);
    for (const [key, child] of value.entries) inspectValue(structure, child, state, `${context}.${key}`);
  } else if (value.type === 'array') for (const child of value.values) inspectValue(structure, child, state, context);
}

function admitPassiveSource(source) {
  if (source.length < 32 || source.length > MAX_SOURCE_BYTES) unsupported('Source size is outside the bounded range.');
  let structure;
  try { structure = parseClassicPdfStructure(source); } catch { unsupported('Only valid classic-xref PDFs are accepted.'); }
  if (structure.revisions.length > 1 || structure.id || structure.info) unsupported('Incremental, identified, or Info-bearing sources are not admitted.');
  const catalog = resolveClassicPdfObject(structure, structure.root);
  const entries = pdfDictionary(catalog.value);
  if (catalog.stream || entries.get('Type')?.value !== 'Catalog' || entries.size !== 2) unsupported('Catalog must be a direct minimal Catalog/Pages pair.');
  if (entries.get('Pages')?.type !== 'ref') unsupported('Catalog Pages must be a direct reference.');
  const visited = new Set(); const pages = [];
  const walk = (reference, kind, parent = null) => {
    const key = `${reference.object}:${reference.generation}`; if (visited.has(key)) unsupported('Unsupported cyclic PDF graph.'); visited.add(key);
    const object = resolveClassicPdfObject(structure, reference); if (object.stream) { if (kind !== 'content') unsupported('Unsupported stream graph.'); return object; }
    const value = pdfDictionary(object.value); inspectValue(structure, object.value, {}, kind);
    if (kind === 'pages') {
      if (value.get('Type')?.value !== 'Pages' || value.get('Kids')?.type !== 'array' || value.get('Count')?.type !== 'number') unsupported('Pages tree is not direct and bounded.');
      rejectUnexpected(value, new Set(['Type', 'Parent', 'Kids', 'Count', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate', 'Resources']), 'Pages');
      for (const child of value.get('Kids').values) { if (child.type !== 'ref') unsupported('Pages Kids must be references.'); const childObject = resolveClassicPdfObject(structure, child); const childValue = pdfDictionary(childObject.value); if (childValue.get('Type')?.value === 'Pages') walk(child, 'pages', reference); else if (childValue.get('Type')?.value === 'Page') walk(child, 'page', reference); else unsupported('Pages tree contains an unsupported node.'); }
      return object;
    }
    if (kind === 'page') {
      if (value.get('Type')?.value !== 'Page' || value.get('Parent')?.type !== 'ref' || !sameRef(value.get('Parent'), parent) || value.has('Annots')) unsupported('Pages must have no existing annotations and a direct parent.');
      rejectUnexpected(value, new Set(['Type', 'Parent', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate', 'Resources', 'Contents']), 'Page');
      const contents = value.get('Contents'); if (contents?.type === 'ref') walk(contents, 'content'); else if (contents?.type === 'array') for (const child of contents.values) { if (child.type !== 'ref') unsupported('Page Contents must be references.'); walk(child, 'content'); }
      if (value.get('Resources')?.type === 'ref') walk(value.get('Resources'), 'resource');
      pages.push(reference); return object;
    }
    if (kind === 'resource') { for (const child of value.values?.values ?? []) inspectValue(structure, child, {}, 'resource'); return object; }
    return object;
  };
  walk(entries.get('Pages'), 'pages');
  // The effective graph must not contain hidden signatures, actions, forms, or unsupported streams.
  for (const entry of structure.effective.values()) if (entry.status === 'n') {
    const object = resolveClassicPdfObject(structure, ref(entry.object, entry.generation));
    if (object.value?.type === 'dict') {
      const values = pdfDictionary(object.value); rejectKeys(values, new Set(['Sig', 'ByteRange', 'AcroForm', 'Annots', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms']), `object ${entry.object}`);
      if (values.get('Type')?.value === 'Sig' || values.get('Subtype')?.value === 'Widget') unsupported('Existing signature or widget found.');
    }
  }
  if (pages.length > MAX_PAGES) unsupported('Pages tree exceeds the bounded page limit.');
  if (visited.size > 10_000) unsupported('PDF object graph exceeds the bounded object limit.');
  return Object.freeze({ structure, pages });
}

function text(value) { return value ? pdfUtf16BeString(value) : null; }

function makeAppend(source, request, admission) {
  const page = admission.pages[request.page - 1]; if (!page) invalid('page is outside the direct Pages tree.');
  const sigId = pendingClassicObjectReference('sig'); const widgetId = pendingClassicObjectReference('widget'); const acroId = pendingClassicObjectReference('acro');
  const placeholder = Buffer.alloc(request.placeholderBytes);
  const zeros = `<${placeholder.toString('hex').toUpperCase()}>`;
  const br = array([number(0, '0000000000'), number(0, '0000000000'), number(0, '0000000000'), number(0, '0000000000')]);
  const sigEntries = [['Type', name('Sig')], ['Filter', name('Adobe.PPKLite')], ['SubFilter', name('adbe.pkcs7.detached')], ['ByteRange', br], ['Contents', { type: 'string', bytes: placeholder }], ['Reason', text(request.reason)], ['Location', text(request.location)], ['ContactInfo', text(request.contact)]];
  if (!request.reason) sigEntries.splice(sigEntries.findIndex(([key]) => key === 'Reason'), 1);
  if (!request.location) sigEntries.splice(sigEntries.findIndex(([key]) => key === 'Location'), 1);
  if (!request.contact) sigEntries.splice(sigEntries.findIndex(([key]) => key === 'ContactInfo'), 1);
  const widget = dict([['Type', name('Annot')], ['Subtype', name('Widget')], ['FT', name('Sig')], ['Rect', array([number(0), number(0), number(0), number(0)])], ['F', number(4)], ['T', pdfUtf16BeString(request.fieldName)], ['V', sigId], ['P', page]]);
  const acro = dict([['Fields', array([widgetId])], ['SigFlags', number(3)] ]);
  const catalog = resolveClassicPdfObject(admission.structure, admission.structure.root); const catalogEntries = new Map(pdfDictionary(catalog.value)); catalogEntries.set('AcroForm', acroId);
  const pageObject = resolveClassicPdfObject(admission.structure, page); const pageEntries = new Map(pdfDictionary(pageObject.value)); pageEntries.set('Annots', array([widgetId]));
  let transaction;
  try {
    transaction = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: admission.structure, updates: [
      { reference: admission.structure.root, value: dict(catalogEntries) }, { reference: page, value: dict(pageEntries) },
    ], additions: [{ id: 'sig', value: dict(sigEntries) }, { id: 'widget', value: widget }, { id: 'acro', value: acro }], info: { kind: 'preserve' }, changingId: null });
  } catch { unsupported('The append-only signature revision could not be planned.'); }
  const append = Buffer.from(transaction.revision.bytes);
  const contentsPattern = Buffer.from(`/Contents ${zeros}`, 'latin1'); const contentsAt = append.indexOf(contentsPattern); if (contentsAt < 0) invalid('Signature Contents placeholder was not emitted.');
  const contentsStart = source.length + contentsAt + Buffer.byteLength('/Contents ', 'latin1'); const contentsEnd = contentsStart + contentsPattern.length - Buffer.byteLength('/Contents ', 'latin1');
  const byteRangePattern = Buffer.from('[0000000000 0000000000 0000000000 0000000000]', 'latin1'); const byteRangeAt = append.indexOf(byteRangePattern); if (byteRangeAt < 0) invalid('Signature ByteRange placeholder was not emitted.');
  const first = contentsStart; const second = contentsEnd; const values = [0, first, second, source.length + append.length - second];
  if (values.some((value) => value < 0 || value > 9_999_999_999 || !Number.isSafeInteger(value))) invalid('ByteRange exceeds fixed-width bounds.');
  const patched = Buffer.from(append); Buffer.from(`[${values.map((value) => String(value).padStart(BYTE_RANGE_WIDTH, '0')).join(' ')}]`, 'latin1').copy(patched, byteRangeAt);
  const bytes = Buffer.concat([source, patched]); const byteRange = Object.freeze(values); const bytesToSign = Buffer.concat([bytes.subarray(0, first), bytes.subarray(second)]);
  return Object.freeze({ bytes, patched, append: transaction.revision, byteRange, bytesToSign, contentsStart, contentsEnd, page, references: Object.freeze({ sig: transaction.referencesById.sig, widget: transaction.referencesById.widget, acro: transaction.referencesById.acro }), sourceStructure: admission.structure });
}

function derLength(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes[0] !== 0x30) return null;
  const first = bytes[1];
  if ((first & 0x80) === 0) return 2 + first <= bytes.length ? 2 + first : null;
  const count = first & 0x7f;
  if (count < 1 || count > 4 || bytes.length < 2 + count || bytes[2] === 0) return null;
  let length = 0;
  for (let index = 0; index < count; index += 1) length = (length * 256) + bytes[2 + index];
  if (length < 128 || 2 + count + length > bytes.length) return null;
  return 2 + count + length;
}

function verifyOutputObjects(output, state, cms) {
  const catalog = pdfDictionary(resolveClassicPdfObject(output, output.root).value);
  if (!sameRef(catalog.get('AcroForm'), state.references.acro)) outputInvalid();
  const acro = pdfDictionary(resolveClassicPdfObject(output, state.references.acro).value);
  if (acro.get('SigFlags')?.value !== 3 || acro.get('Fields')?.type !== 'array' || acro.get('Fields').values.length !== 1 || !sameRef(acro.get('Fields').values[0], state.references.widget)) outputInvalid();
  const page = pdfDictionary(resolveClassicPdfObject(output, state.page).value); const annots = page.get('Annots');
  if (annots?.type !== 'array' || annots.values.length !== 1 || !sameRef(annots.values[0], state.references.widget)) outputInvalid();
  const widget = pdfDictionary(resolveClassicPdfObject(output, state.references.widget).value);
  if (widget.get('Type')?.value !== 'Annot' || widget.get('Subtype')?.value !== 'Widget' || widget.get('FT')?.value !== 'Sig' || widget.get('F')?.value !== 4 || widget.get('Rect')?.type !== 'array' || widget.get('Rect').values.some((entry) => entry?.value !== 0) || !sameRef(widget.get('P'), state.page) || !sameRef(widget.get('V'), state.references.sig) || widget.get('T')?.type !== 'string' || !widget.get('T').bytes.equals(pdfUtf16BeString(state.request.fieldName).bytes)) outputInvalid();
  const sig = pdfDictionary(resolveClassicPdfObject(output, state.references.sig).value);
  if (sig.get('Type')?.value !== 'Sig' || sig.get('Filter')?.value !== 'Adobe.PPKLite' || sig.get('SubFilter')?.value !== 'adbe.pkcs7.detached' || sig.get('ByteRange')?.type !== 'array' || sig.get('ByteRange').values.some((entry, index) => entry?.value !== state.byteRange[index]) || sig.get('Contents')?.type !== 'string' || !sig.get('Contents').bytes.equals(Buffer.concat([cms, Buffer.alloc(state.request.placeholderBytes - cms.length)]))) outputInvalid();
}

function proof(request, source, prepared, extra = {}) {
  return Object.freeze({ profile: PDF_SIGNATURE_CONTAINER_PROFILE, sourceSha256: request.sourceSha256, page: request.page, fieldName: request.fieldName, placeholderBytes: request.placeholderBytes, byteRange: prepared.byteRange, bytesToSignSha256: digest(prepared.bytesToSign), sourcePrefixPreserved: true, ...extra });
}

export function preparePdfSignatureContainer(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes)) invalid('sourceBytes must be a Buffer.');
  const source = Buffer.from(sourceBytes); const normalized = normalizeRequest(request, source); const admission = admitPassiveSource(source); const prepared = makeAppend(source, normalized, admission);
  const publicProof = proof(normalized, source, prepared);
  const result = Object.freeze({ bytes: prepared.bytes, proof: publicProof });
  PREPARED.set(result, Object.freeze({ ...prepared, proof: publicProof, request: normalized, source: Buffer.from(source), result }));
  return result;
}

export function getPreparedPdfSignatureBytesToSign(preparedResult) {
  const state = PREPARED.get(preparedResult); if (!state) invalid('The prepared container authority is invalid.');
  return Buffer.from(state.bytesToSign);
}

export function embedDetachedCms(preparedResult, cmsBytes) {
  const state = PREPARED.get(preparedResult); if (!state || !Buffer.isBuffer(cmsBytes) || cmsBytes.length < 1 || cmsBytes.length > state.request.placeholderBytes) invalid('The prepared container or CMS bytes are invalid.');
  const derSize = derLength(cmsBytes); if (derSize === null || derSize !== cmsBytes.length) invalid('CMS bytes must be one bounded DER-like outer sequence.');
  const finalBytes = Buffer.from(state.bytes); const hex = Buffer.alloc(state.request.placeholderBytes * 2, 0x30); Buffer.from(cmsBytes.toString('hex').toUpperCase(), 'latin1').copy(hex); hex.copy(finalBytes, state.contentsStart + 1);
  const cmsSha256 = digest(cmsBytes); const finalResult = Object.freeze({ bytes: finalBytes, proof: proof(state.request, state.source, state, { cmsSha256, cmsBytes: cmsBytes.length, contentsPaddingBytes: state.request.placeholderBytes - cmsBytes.length, byteRange: state.byteRange }) });
  FINAL.set(finalResult, Object.freeze({ ...state, cms: Buffer.from(cmsBytes), finalBytes, finalResult }));
  return finalResult;
}

export function inspectPdfSignatureContainer(sourceBytes, finalBytes, request, expectedCmsSha256) {
  if (!Buffer.isBuffer(sourceBytes) || !Buffer.isBuffer(finalBytes) || typeof expectedCmsSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedCmsSha256)) invalid('Inspection arguments are invalid.');
  const preparedResult = preparePdfSignatureContainer(sourceBytes, request); const state = PREPARED.get(preparedResult); if (!state || finalBytes.length !== state.bytes.length) outputInvalid();
  if (!finalBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) outputInvalid();
  const structure = parseClassicPdfStructure(finalBytes); if (structure.revisions.length !== 2) outputInvalid();
  const values = state.byteRange; const actual = finalBytes.subarray(state.contentsStart + 1, state.contentsEnd - 1).toString('latin1'); if (!/^[0-9A-F]*$/u.test(actual)) outputInvalid();
  let padded; try { padded = Buffer.from(actual, 'hex'); } catch { outputInvalid(); }
  const derSize = derLength(padded); if (derSize === null || derSize > padded.length) outputInvalid();
  const cms = padded.subarray(0, derSize);
  if (cms.length < 1 || digest(cms) !== expectedCmsSha256) outputInvalid();
  const signed = Buffer.concat([finalBytes.subarray(0, values[1]), finalBytes.subarray(values[2])]); if (digest(signed) !== state.proof.bytesToSignSha256) outputInvalid();
  verifyOutputObjects(structure, state, cms);
  const rebuilt = embedDetachedCms(preparedResult, cms);
  if (!rebuilt.bytes.equals(finalBytes)) outputInvalid();
  const actualText = finalBytes.subarray(state.contentsStart, state.contentsEnd).toString('latin1'); if (!actualText.startsWith('<') || !actualText.endsWith('>')) outputInvalid();
  const finalResult = Object.freeze({ bytes: finalBytes, proof: proof(state.request, sourceBytes, state, { cmsSha256: expectedCmsSha256, cmsBytes: cms.length, contentsPaddingBytes: state.request.placeholderBytes - cms.length, byteRange: values }) }); FINAL.set(finalResult, Object.freeze({ ...state, cms, finalBytes, finalResult })); return finalResult.proof;
}
