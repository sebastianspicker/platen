import { createHash } from 'node:crypto';
import { pdfDictionary, pdfInteger, pdfReference } from './pdf-classic-syntax.mjs';
import { parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { tokenizePdfContentStream } from './pdf-content-stream-tokenizer.mjs';

export const PDF_JPEG_IMAGE_REPLACEMENT_PROFILE = 'local-pdf-jpeg-image-replacement-v1';
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_JPEG_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_PAGE_COUNT = 10_000;
const MAX_OBJECTS = 20_000;
const UNSAFE_KEYS = new Set(['AA', 'A', 'AcroForm', 'AF', 'Collection', 'Encrypt', 'JS', 'JavaScript', 'Metadata', 'Names', 'OCProperties', 'OpenAction', 'Outlines', 'Perms', 'PieceInfo', 'StructTreeRoot', 'Sig', 'XFA', 'OC', 'OCGs', 'OCMD', 'StructParents', 'ParentTree', 'MarkInfo', 'Tabs', 'StructTreeRoot', 'RoleMap', 'ClassMap', 'Lang', 'ViewerPreferences', 'OutputIntents']);
const IMAGE_KEYS = new Set(['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter', 'Length']);
const OPERATOR_ARITIES = new Map([['q', 0], ['Q', 0], ['cm', 6], ['Do', 1]]);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function invalid(message = 'The PDF JPEG replacement request is invalid.') { throw failure('INVALID_PDF_JPEG_IMAGE_REPLACEMENT', message); }
function unsupported(message = 'The PDF is outside the supported bounded JPEG replacement subset.') { throw failure('UNSUPPORTED_PDF_JPEG_IMAGE_REPLACEMENT', message); }
function invalidOutput(message = 'The PDF JPEG replacement output failed deterministic verification.') { throw failure('INVALID_PDF_JPEG_IMAGE_REPLACEMENT_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function referenceText(reference) { return `${reference.object} ${reference.generation} R`; }
function ref(value) { try { return pdfReference(value); } catch { unsupported(); } }
function dict(value) { try { return pdfDictionary(value); } catch { unsupported(); } }
function pdfNumber(value) { return Object.freeze({ type: 'number', value, integer: Number.isInteger(value), raw: String(value) }); }
function pdfName(value) { return Object.freeze({ type: 'name', value }); }
function pdfReferenceValue(reference) { return Object.freeze({ type: 'ref', object: reference.object, generation: reference.generation }); }
function pdfDict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return value;
}

function parseJpeg(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_JPEG_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid('jpegBytes must be one bounded JPEG image.');
  let offset = 2; let width = null; let height = null; let components = null; let sawSof = false; let sawSos = false; let sawEoi = false; let componentIds = [];
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid('JPEG markers are malformed.');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) invalid('JPEG markers are truncated.');
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) { if (marker === 0xd9 && sawSos) { sawEoi = true; break; } invalid('JPEG contains an unexpected SOI or EOI marker.'); }
    if (marker === 0xda) {
      if (sawSos || !sawSof || offset + 2 > bytes.length) invalid('JPEG must contain exactly one scan after SOF0.');
      const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length || length !== 6 + (2 * components) || bytes[offset + 2] !== components) invalid('JPEG scan header is malformed.');
      const scanIds = []; for (let index = 0; index < components; index += 1) { const id = bytes[offset + 3 + (index * 2)]; const selector = bytes[offset + 4 + (index * 2)]; if (!componentIds.includes(id) || scanIds.includes(id) || selector > 0x33) invalid('JPEG scan component identifiers are malformed.'); scanIds.push(id); }
      if (bytes[offset + 3 + (components * 2)] !== 0 || bytes[offset + 4 + (components * 2)] !== 63 || bytes[offset + 5 + (components * 2)] !== 0) invalid('JPEG scan spectral bounds are unsupported.');
      sawSos = true; offset += length;
      while (offset + 1 < bytes.length) { if (bytes[offset] === 0xff && bytes[offset + 1] === 0xd9) { offset += 2; sawEoi = true; break; } if (bytes[offset] === 0xff && bytes[offset + 1] === 0x00) { offset += 2; continue; } if (bytes[offset] === 0xff) invalid('JPEG restart or multi-scan markers are unsupported.'); offset += 1; }
      if (sawEoi) break; invalid('JPEG scan data has no direct EOI marker.');
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) invalid('JPEG restart or nested SOI markers are unsupported.');
    if (offset + 2 > bytes.length) invalid('JPEG segment length is truncated.');
    const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) invalid('JPEG segment length is malformed.');
    if (marker === 0xc0) {
      if (sawSof || length < 8 || bytes[offset + 2] !== 8) invalid('JPEG must contain exactly one eight-bit SOF0.');
      height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); components = bytes[offset + 7];
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || ![1, 3].includes(components) || length !== 8 + (3 * components)) invalid('JPEG must be baseline grayscale or RGB.');
      componentIds = []; for (let index = 0; index < components; index += 1) { const at = offset + 8 + (index * 3); const id = bytes[at]; const sampling = bytes[at + 1]; if (!id || componentIds.includes(id) || (sampling >> 4) < 1 || (sampling & 0x0f) < 1 || (sampling >> 4) > 4 || (sampling & 0x0f) > 4 || bytes[at + 2] > 3) invalid('JPEG SOF0 component records are malformed.'); componentIds.push(id); } sawSof = true;
    } else if (marker >= 0xc1 && marker <= 0xcf && marker !== 0xc4) unsupported('Only baseline JPEG SOF0 encoding is supported.');
    offset += length;
  }
  if (!sawSof || !sawSos || !sawEoi || width === null || offset !== bytes.length) invalid('JPEG must contain one complete baseline image.');
  return Object.freeze({ bytes: Buffer.from(bytes), width, height, components, sha256: digest(bytes) });
}

function normalizeRequest(value, source) {
  exactObject(value, ['profile', 'sourceSha256', 'page', 'resourceName', 'jpegBytes']);
  if (value.profile !== PDF_JPEG_IMAGE_REPLACEMENT_PROFILE || typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sourceSha256) || value.sourceSha256 !== digest(source)) invalid('sourceSha256 does not match source bytes.');
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > MAX_PAGE_COUNT) invalid('page is outside the bounded range.');
  if (typeof value.resourceName !== 'string' || !/^[A-Za-z0-9_.-]{1,127}$/u.test(value.resourceName)) invalid('resourceName is not a bounded PDF resource name.');
  return Object.freeze({ profile: PDF_JPEG_IMAGE_REPLACEMENT_PROFILE, sourceSha256: value.sourceSha256, page: value.page, resourceName: value.resourceName, jpeg: parseJpeg(value.jpegBytes) });
}

function rejectUnsafeValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return; seen.add(value);
  if (value.type === 'ref') return;
  if (value.type === 'dict') for (const [key, child] of value.entries) { if (UNSAFE_KEYS.has(key)) unsupported('The source contains active, tagged, layered, or signed content.'); rejectUnsafeValue(child, seen); }
  else if (value.type === 'array') for (const child of value.values) rejectUnsafeValue(child, seen);
}

function pageObjects(structure) {
  const resolveValue = (value) => value?.type === 'ref' ? resolvePdfObject(structure, ref(value)).value : value;
  const catalog = dict(resolvePdfObject(structure, structure.root).value);
  if (catalog.get('Type')?.value !== 'Catalog' || catalog.get('Pages')?.type !== 'ref' || [...UNSAFE_KEYS].some((key) => catalog.has(key))) unsupported();
  const pages = []; const seen = new Set();
  function walk(reference, parent, depth) {
    if (depth > 16 || seen.size >= MAX_OBJECTS || seen.has(referenceText(reference))) unsupported(); seen.add(referenceText(reference));
    const object = resolvePdfObject(structure, reference); if (object.stream) unsupported(); const entries = dict(object.value); const type = entries.get('Type')?.value;
    if (type === 'Pages') {
      const kids = resolveValue(entries.get('Kids')); const count = resolveValue(entries.get('Count'));
      if (parent || kids?.type !== 'array' || count?.type !== 'number' || entries.has('MediaBox') || entries.has('CropBox') || entries.has('Resources')) unsupported();
      for (const child of kids.values) walk(ref(child), reference, depth + 1); return;
    }
    const mediaValue = resolveValue(entries.get('MediaBox')); const cropValue = resolveValue(entries.get('CropBox')); const resourceValue = resolveValue(entries.get('Resources'));
    if (type !== 'Page' || !parent || referenceText(ref(entries.get('Parent'))) !== referenceText(parent) || mediaValue?.type !== 'array' || cropValue?.type !== 'array') unsupported();
    if (entries.has('Annots') || entries.has('AA') || entries.has('A') || entries.has('Rotate') || entries.has('Metadata') || resourceValue?.type !== 'dict') unsupported();
    const media = mediaValue.values.map((entry) => pdfInteger(entry)); const crop = cropValue.values.map((entry) => pdfInteger(entry));
    if (media.length !== 4 || crop.length !== 4 || media[0] >= media[2] || media[1] >= media[3] || crop[0] >= crop[2] || crop[1] >= crop[3] || crop[0] < media[0] || crop[1] < media[1] || crop[2] > media[2] || crop[3] > media[3]) unsupported();
    pages.push(Object.freeze({ reference, entries, crop }));
  }
  walk(ref(catalog.get('Pages')), null, 0); if (!pages.length || pages.length > MAX_PAGE_COUNT) unsupported();
  for (const [objectNumber, entry] of structure.effective) if (['n', 'c'].includes(entry.status)) rejectUnsafeValue(resolvePdfObject(structure, { type: 'ref', object: objectNumber, generation: entry.generation }).value);
  return pages;
}

function imageResource(structure, value) {
  const resources = dict(value); if ([...resources.keys()].some((key) => key !== 'XObject')) unsupported('Non-image resources are unsupported.');
  const xObjectValue = resources.get('XObject'); if (xObjectValue === undefined) return new Map(); if (xObjectValue.type !== 'dict') unsupported();
  const result = new Map(); const refs = new Set();
  for (const [name, candidate] of xObjectValue.entries) {
    if (!/^[A-Za-z0-9_.-]{1,127}$/u.test(name) || candidate.type !== 'ref') unsupported();
    const reference = ref(candidate); const key = referenceText(reference); if (refs.has(key)) unsupported('XObject aliases are unsupported.'); refs.add(key);
    const object = resolvePdfObject(structure, reference); if (!object.stream || object.value?.type !== 'dict') unsupported(); const entries = dict(object.value);
    if ([...entries.keys()].some((key) => !IMAGE_KEYS.has(key)) || entries.get('Type')?.value !== 'XObject' || entries.get('Subtype')?.value !== 'Image' || entries.get('Width')?.type !== 'number' || !entries.get('Width').integer || entries.get('Width').value < 1 || entries.get('Width').value > MAX_DIMENSION || entries.get('Height')?.type !== 'number' || !entries.get('Height').integer || entries.get('Height').value < 1 || entries.get('Height').value > MAX_DIMENSION || entries.get('BitsPerComponent')?.type !== 'number' || entries.get('BitsPerComponent').value !== 8 || entries.get('ColorSpace')?.type !== 'name' || !['DeviceGray',
'DeviceRGB'].includes(entries.get('ColorSpace').value) || entries.get('Filter')?.type !== 'name' || entries.get('Filter').value !== 'DCTDecode' || entries.get('Length')?.type !== 'number' || !entries.get('Length').integer || entries.get('Length').value !== object.streamLength) unsupported('The XObject is outside the direct baseline JPEG image subset.');
    result.set(name, Object.freeze({ name, reference, object, entries, components: entries.get('ColorSpace').value === 'DeviceGray' ? 1 : 3, width: entries.get('Width').value, height: entries.get('Height').value, streamSha256: digest(object.buffer ?? Buffer.alloc(0)) }));
  }
  return result;
}
function pageResources(structure, page) { const value = page.entries.get('Resources'); return imageResource(structure, value?.type === 'ref' ? resolvePdfObject(structure, ref(value)).value : value); }

function multiply(left, right) { return [left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1], left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3], left[0] * right[4] + left[2] * right[5] + left[4], left[1] * right[4] + left[3] * right[5] + left[5]]; }
function scanContent(source, structure, page, resources) {
  const contents = page.entries.get('Contents'); const refs = contents === undefined ? [] : contents.type === 'ref' ? [ref(contents)] : contents.type === 'array' ? contents.values.map((entry) => ref(entry)) : null; if (!refs || new Set(refs.map(referenceText)).size !== refs.length || refs.length < 1) unsupported('Page content graph is ambiguous.');
  const uses = []; let depth = 0; let ctm = [1, 0, 0, 1, 0, 0]; const graphics = [];
  for (const reference of refs) {
    const stream = resolvePdfObject(structure, reference); if (!stream.stream || stream.value?.type !== 'dict' || stream.value.entries.has('Filter') || stream.value.entries.has('DecodeParms') || stream.value.entries.get('Length')?.type !== 'number' || stream.value.entries.get('Length').value !== stream.streamLength) unsupported('Filtered or ambiguous content stream.');
    let tokenized; try { tokenized = tokenizePdfContentStream({ sourceBytes: source, stream }); } catch { unsupported('Content stream is malformed or unsupported.'); }
    const operands = [];
    for (const token of tokenized.tokens) {
      if (token.type === 'number' || token.type === 'name') { operands.push(token); continue; }
      if (token.type !== 'operator' || !OPERATOR_ARITIES.has(token.value)) unsupported('Content contains a dynamic or unsupported operator.');
      const arity = OPERATOR_ARITIES.get(token.value); if (operands.length !== arity) unsupported('Content operator has ambiguous operands.');
      const args = operands.splice(0);
      if (token.value === 'q') { depth += 1; if (depth > 32) unsupported(); graphics.push([...ctm]); }
      else if (token.value === 'Q') { if (!depth) unsupported('Graphics state is unbalanced.'); depth -= 1; ctm = graphics.pop(); }
      else if (token.value === 'cm') { if (args.some((arg) => arg.type !== 'number' || !Number.isFinite(arg.value))) unsupported(); ctm = multiply(ctm, args.map((arg) => arg.value)); if (ctm.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e9)) unsupported(); }
      else if (token.value === 'Do') { if (args[0]?.type !== 'name' || !resources.has(args[0].value)) unsupported('Do must name a page image resource.'); uses.push(Object.freeze({ name: args[0].value, reference, ctm: Object.freeze([...ctm]) })); }
    }
    if (operands.length) unsupported('Content has dangling operands.');
  }
  if (depth !== 0) unsupported('Graphics state is unbalanced.');
  return uses;
}

function admission(sourceBytes, requestValue) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 32 || sourceBytes.length > MAX_SOURCE_BYTES) unsupported();
  let structure; try { structure = parsePdfStructure(sourceBytes); } catch { unsupported('Only classic-xref PDFs are supported.'); }
  if (!['classic', 'stream'].includes(structure.xrefFlavor) || structure.id || structure.info) unsupported('Identified or Info-bearing sources are unsupported.');
  const request = normalizeRequest(requestValue, sourceBytes); const pages = pageObjects(structure); const byPage = pages.map((page) => pageResources(structure, page)); const globalRefs = new Map();
  for (const [index, resources] of byPage.entries()) for (const image of resources.values()) { const key = referenceText(image.reference); const locations = globalRefs.get(key) ?? []; locations.push({ page: index + 1, name: image.name }); globalRefs.set(key, locations); }
  for (const locations of globalRefs.values()) if (locations.length > 1) unsupported('Image objects shared across page resources are unsupported.');
  const uses = pages.flatMap((page, index) => scanContent(sourceBytes, structure, page, byPage[index]).map((use) => ({ ...use, page: index + 1 })));
  const resources = byPage[request.page - 1]; const target = resources?.get(request.resourceName); if (!target) unsupported('The requested image resource does not exist on the selected page.');
  const targetUses = uses.filter((use) => use.page === request.page && use.name === request.resourceName); if (targetUses.length !== 1 || uses.some((use) => use.name === request.resourceName && use.page !== request.page)) unsupported('The target image must be invoked exactly once.');
  if (request.jpeg.components !== target.components) unsupported('Replacement JPEG components must match the target image color space.');
  return Object.freeze({ request, structure, pages, resources: byPage, target, targetUse: targetUses[0], uses });
}

function build(sourceBytes, requestValue) {
  const state = admission(sourceBytes, requestValue); const target = state.target; const imageValue = pdfDict([['Type', pdfName('XObject')], ['Subtype', pdfName('Image')], ['Width', pdfNumber(state.request.jpeg.width)], ['Height', pdfNumber(state.request.jpeg.height)], ['ColorSpace', pdfName(target.components === 1 ? 'DeviceGray' : 'DeviceRGB')], ['BitsPerComponent', pdfNumber(8)], ['Filter', pdfName('DCTDecode')], ['Length', pdfNumber(state.request.jpeg.bytes.length)]]);
  const transaction = planPdfObjectTransaction({ sourceBytes, sourceStructure: state.structure, updates: [{ reference: target.reference, value: imageValue, streamBytes: state.request.jpeg.bytes }], additions: [], info: { kind: 'preserve' }, changingId: null });
  const bytes = Buffer.concat([sourceBytes, transaction.revision.bytes]); const proof = Object.freeze({ profile: PDF_JPEG_IMAGE_REPLACEMENT_PROFILE, sourceSha256: state.request.sourceSha256, page: state.request.page, resourceName: state.request.resourceName, targetReference: referenceText(target.reference), sourceImage: Object.freeze({ width: target.width, height: target.height, components: target.components, sha256: digest(sourceBytes.subarray(target.object.streamStart, target.object.streamStart + target.object.streamLength)) }), replacementImage: Object.freeze({ width: state.request.jpeg.width, height: state.request.jpeg.height, components: state.request.jpeg.components, bytes: state.request.jpeg.bytes.length, sha256: state.request.jpeg.sha256 }), invocation: Object.freeze({ contentReference: referenceText(state.targetUse.reference),
ctm: state.targetUse.ctm }), sourcePrefixPreserved: true, contentPreserved: true, resourceIdentityPreserved: true, objectIdentityPreserved: true, revisionCount: state.structure.revisions.length + 1 });
  return Object.freeze({ bytes, proof, state, transaction });
}

function inspect(sourceBytes, outputBytes, requestValue, expectedProof) {
  const expected = build(sourceBytes, requestValue); if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(expected.bytes)) invalidOutput(); if (!outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) invalidOutput();
  const output = parsePdfStructure(outputBytes); if (output.revisions.length !== expected.state.structure.revisions.length + 1) invalidOutput(); const rawOutputTarget = resolvePdfObject(output, expected.state.target.reference); if (!rawOutputTarget.stream || rawOutputTarget.streamLength !== expected.state.request.jpeg.bytes.length || !outputBytes.subarray(rawOutputTarget.streamStart, rawOutputTarget.streamStart + rawOutputTarget.streamLength).equals(expected.state.request.jpeg.bytes)) invalidOutput();
  const outputEntries = dict(rawOutputTarget.value); if (outputEntries.get('Filter')?.value !== 'DCTDecode' || pdfInteger(outputEntries.get('Width')) !== expected.state.request.jpeg.width || pdfInteger(outputEntries.get('Height')) !== expected.state.request.jpeg.height || outputEntries.get('Length')?.value !== expected.state.request.jpeg.bytes.length) invalidOutput();
  for (const [objectNumber, entry] of expected.state.structure.effective) { if (objectNumber === expected.state.target.reference.object) continue; const after = output.effective.get(objectNumber); if (!after || after.status !== entry.status || after.generation !== entry.generation || after.offset !== entry.offset) invalidOutput(); }
  let outputPages; let outputResources; let outputUses;
  try {
    outputPages = pageObjects(output);
    outputResources = outputPages.map((page) => pageResources(output, page));
    outputUses = outputPages.flatMap((page, index) => scanContent(outputBytes, output, page, outputResources[index]).map((use) => ({ ...use, page: index + 1 })));
  } catch { invalidOutput(); }
  const outputTarget = outputResources[expected.state.request.page - 1]?.get(expected.state.request.resourceName);
  const outputTargetUses = outputUses.filter((use) => use.page === expected.state.request.page && use.name === expected.state.request.resourceName);
  if (!outputTarget || referenceText(outputTarget.reference) !== expected.proof.targetReference || outputTargetUses.length !== 1 || referenceText(outputTargetUses[0].reference) !== expected.proof.invocation.contentReference || JSON.stringify(outputTargetUses[0].ctm) !== JSON.stringify(expected.proof.invocation.ctm)) invalidOutput();
  if (expectedProof && JSON.stringify(expectedProof) !== JSON.stringify(expected.proof)) invalidOutput(); return expected.proof;
}

export function writePdfJpegImageReplacement(sourceBytes, request) { const result = build(sourceBytes, request); inspect(sourceBytes, result.bytes, request, result.proof); return Object.freeze({ bytes: result.bytes, proof: result.proof }); }
export function inspectPdfJpegImageReplacement(sourceBytes, outputBytes, request, expectedProof = undefined) { return inspect(sourceBytes, outputBytes, request, expectedProof); }
export { parseJpeg };
