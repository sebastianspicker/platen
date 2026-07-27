import { createHash } from 'node:crypto';
import { pdfDictionary, pdfInteger, pdfReference } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';

export const PDF_JPEG_IMAGE_PROFILE = 'local-pdf-jpeg-image-v1';
export const PDF_JPEG_IMAGE_INSERTION_PROFILE = PDF_JPEG_IMAGE_PROFILE;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_JPEG_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_PAGE_COUNT = 10_000;
const MAX_OBJECTS = 20_000;
const UNSAFE_KEYS = new Set(['AA', 'A', 'AcroForm', 'AF', 'Collection', 'Encrypt', 'JS', 'JavaScript', 'Metadata', 'Names', 'OCProperties', 'OpenAction', 'Outlines', 'Perms', 'PieceInfo', 'StructTreeRoot', 'Sig', 'XFA']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function invalid(message = 'The PDF JPEG image request is invalid.') { throw failure('INVALID_PDF_JPEG_IMAGE', message); }
function unsupported(message = 'The PDF is outside the supported bounded JPEG image subset.') { throw failure('UNSUPPORTED_PDF_JPEG_IMAGE_SOURCE', message); }
function invalidOutput(message = 'The PDF JPEG image output failed deterministic verification.') { throw failure('INVALID_PDF_JPEG_IMAGE_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function refText(reference) { return `${reference.object} ${reference.generation} R`; }
function ref(value) { try { return pdfReference(value); } catch { unsupported(); } }
function dict(value) { try { return pdfDictionary(value); } catch { unsupported(); } }
function pdfNumber(value) { return Object.freeze({ type: 'number', value, integer: Number.isInteger(value), raw: String(value) }); }
function pdfName(value) { return Object.freeze({ type: 'name', value }); }
function pdfArray(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function pdfDict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid();
  return value;
}

function parseJpeg(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_JPEG_BYTES
    || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid('jpegBytes must be one bounded JPEG image.');
  let offset = 2; let width = null; let height = null; let components = null; let sawSof = false; let sawSos = false; let sawEoi = false; let componentIds = [];
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid('JPEG markers are malformed.');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) invalid('JPEG markers are truncated.');
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) { if (marker === 0xd9 && sawSos) { sawEoi = true; break; } invalid('JPEG contains an unexpected SOI or EOI marker.'); }
    if (marker === 0xda) { // This narrow profile admits exactly one baseline scan and a direct EOI.
      if (sawSos || !sawSof) invalid('JPEG must contain exactly one scan after SOF0.');
      if (offset + 2 > bytes.length) invalid('JPEG scan header is truncated.');
      const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) invalid('JPEG scan header is malformed.');
      if (length !== 6 + (2 * components) || bytes[offset + 2] !== components) invalid('JPEG scan components do not match SOF0.');
      const scanIds = []; for (let index = 0; index < components; index += 1) { const id = bytes[offset + 3 + (index * 2)]; const selector = bytes[offset + 4 + (index * 2)]; if (!componentIds.includes(id) || scanIds.includes(id) || (selector >> 4) > 3 || (selector & 0x0f) > 3) invalid('JPEG scan component identifiers or Huffman selectors are malformed.'); scanIds.push(id); }
      if (bytes[offset + 3 + (components * 2)] !== 0 || bytes[offset + 4 + (components * 2)] !== 63 || bytes[offset + 5 + (components * 2)] !== 0) invalid('JPEG scan spectral bounds are unsupported.');
      sawSos = true;
      offset += length;
      while (offset + 1 < bytes.length) { if (bytes[offset] === 0xff && bytes[offset + 1] === 0xd9) { offset += 2; sawEoi = true; break; } if (bytes[offset] === 0xff && bytes[offset + 1] === 0x00) { offset += 2; continue; } if (bytes[offset] === 0xff) invalid('JPEG restart or multi-scan markers are unsupported.'); offset += 1; }
      if (sawEoi) break; invalid('JPEG scan data has no direct EOI marker.');
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) invalid('JPEG restart or nested SOI markers are unsupported.');
    if (offset + 2 > bytes.length) invalid('JPEG segment length is truncated.');
    const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) invalid('JPEG segment length is malformed.');
    if (marker === 0xc0) {
      if (sawSof || length < 8 || bytes[offset + 2] !== 8) invalid('JPEG must contain exactly one eight-bit SOF0.');
      height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); components = bytes[offset + 7];
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || ![1, 3].includes(components)) invalid('JPEG must be baseline grayscale or RGB.');
      if (length !== 8 + (3 * components)) invalid('JPEG SOF0 component records are malformed.');
      componentIds = []; for (let index = 0; index < components; index += 1) { const at = offset + 8 + (index * 3); const id = bytes[at]; const sampling = bytes[at + 1]; if (!id || componentIds.includes(id) || (sampling >> 4) < 1 || (sampling & 0x0f) < 1 || (sampling >> 4) > 4 || (sampling & 0x0f) > 4 || bytes[at + 2] > 3) invalid('JPEG SOF0 component records are malformed.'); componentIds.push(id); } sawSof = true;
    } else if (marker >= 0xc1 && marker <= 0xcf && marker !== 0xc4) {
      unsupported('Only baseline JPEG SOF0 encoding is supported.');
    }
    offset += length;
  }
  if (!sawSof || !sawSos || !sawEoi || width === null || offset !== bytes.length) invalid('JPEG must contain one complete baseline image.');
  return Object.freeze({ bytes: Buffer.from(bytes), width, height, components, sha256: digest(bytes) });
}

function number(value, field, minimum = 0, maximum = 1_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)
    || value < minimum || value > maximum || Number.isInteger(value) && !Number.isSafeInteger(value)) invalid(`${field} is outside the bounded range.`);
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  if (rounded <= minimum && minimum >= 0) invalid(`${field} is outside the bounded range.`);
  return rounded;
}

function normalizeRequest(value, source) {
  exactObject(value, ['profile', 'sourceSha256', 'page', 'rect', 'jpegBytes']);
  if (value.profile !== PDF_JPEG_IMAGE_PROFILE || typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sourceSha256) || value.sourceSha256 !== digest(source)) invalid('sourceSha256 does not match the source bytes.');
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > MAX_PAGE_COUNT) invalid('page is outside the bounded range.');
  exactObject(value.rect, ['x', 'y', 'width', 'height']);
  const rect = Object.freeze({ x: number(value.rect.x, 'rect.x', -1_000_000), y: number(value.rect.y, 'rect.y', -1_000_000), width: number(value.rect.width, 'rect.width', 0), height: number(value.rect.height, 'rect.height', 0) });
  const jpeg = parseJpeg(value.jpegBytes);
  return Object.freeze({ profile: PDF_JPEG_IMAGE_PROFILE, sourceSha256: value.sourceSha256, page: value.page, rect, jpeg });
}

function rejectUnsafeValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'ref') return;
  if (value.type === 'dict') {
    for (const [key, child] of value.entries) { if (UNSAFE_KEYS.has(key)) unsupported('The source contains active, tagged, layered, or signed content.'); rejectUnsafeValue(child, seen); }
  } else if (value.type === 'array') for (const child of value.values) rejectUnsafeValue(child, seen);
}

function collectPages(structure) {
  const catalog = resolvePdfObject(structure, structure.root); const root = dict(catalog.value);
  if (root.get('Type')?.value !== 'Catalog' || [...UNSAFE_KEYS].some((key) => root.has(key)) || root.get('Pages')?.type !== 'ref') unsupported();
  const pages = []; const seen = new Set();
  function walk(reference, parent, depth) {
    if (depth > 16 || seen.size > MAX_OBJECTS) unsupported(); const key = refText(reference); if (seen.has(key)) unsupported(); seen.add(key);
    const object = resolvePdfObject(structure, reference); if (object.stream) unsupported(); const entries = dict(object.value); const type = entries.get('Type')?.value;
    if (type === 'Pages') {
      if (parent || entries.get('Kids')?.type !== 'array' || entries.get('Count')?.type !== 'number' || entries.has('MediaBox') || entries.has('CropBox') || entries.has('Resources')) unsupported();
      for (const child of entries.get('Kids').values) walk(ref(child), reference, depth + 1); return;
    }
    if (type !== 'Page' || !parent || !entries.get('Parent') || !ref(entries.get('Parent'))
      || refText(ref(entries.get('Parent'))) !== refText(parent) || entries.get('MediaBox')?.type !== 'array' || entries.get('CropBox')?.type !== 'array') unsupported();
    if (entries.has('Annots') || entries.has('AA') || entries.has('A') || entries.has('Rotate') || entries.has('Metadata')) unsupported();
    const media = entries.get('MediaBox').values.map((entry) => pdfInteger(entry)); const crop = entries.get('CropBox').values.map((entry) => pdfInteger(entry));
    if (media.length !== 4 || crop.length !== 4 || media[0] >= media[2] || media[1] >= media[3] || crop[0] >= crop[2] || crop[1] >= crop[3]) unsupported();
    if (crop[0] < media[0] || crop[1] < media[1] || crop[2] > media[2] || crop[3] > media[3]) unsupported();
    if (entries.get('Resources')?.type === 'ref') unsupported();
    pages.push(Object.freeze({ reference, entries, crop }));
  }
  walk(ref(root.get('Pages')), null, 0); if (pages.length < 1 || pages.length > MAX_PAGE_COUNT) unsupported();
  for (const [objectNumber, entry] of structure.effective) { if (!['n', 'c'].includes(entry.status)) continue; const object = resolvePdfObject(structure, { type: 'ref', object: objectNumber, generation: entry.generation }); rejectUnsafeValue(object.value); }
  return pages;
}

function resourcePlan(page) {
  const resources = page.entries.get('Resources');
  const entries = resources ? dict(resources) : new Map();
  const xObject = entries.get('XObject');
  if (xObject && xObject.type !== 'dict') unsupported('The page XObject resource graph is ambiguous.');
  if (xObject) {
    const references = [...xObject.entries.values()].map((value) => ref(value));
    if (new Set(references.map(refText)).size !== references.length) unsupported('The page XObject resource graph contains aliases.');
  }
  const names = new Set(xObject ? [...xObject.entries.keys()] : []); let index = 0; while (names.has(`Im${index}`)) index += 1;
  const name = `Im${index}`; const imageRef = pendingClassicObjectReference('jpeg-image'); const contentRef = pendingClassicObjectReference('jpeg-content');
  const imageEntries = new Map(xObject ? xObject.entries : []); imageEntries.set(name, imageRef);
  const updatedResources = new Map(entries); updatedResources.set('XObject', pdfDict(imageEntries));
  return Object.freeze({ name, imageRef, contentRef, resources: pdfDict(updatedResources) });
}

function build(sourceBytes, requestValue) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 32 || sourceBytes.length > MAX_SOURCE_BYTES) unsupported();
  const structure = (() => { try { return parsePdfStructure(sourceBytes); } catch { throw unsupported('Only classic-xref PDFs with direct objects are supported.'); } })();
  if (structure.xrefFlavor !== 'classic' || structure.revisions.length !== 1 || structure.id || structure.info || [...structure.effective.values()].some((entry) => entry.status === 'c')) unsupported('Identified, incremental, compressed, or Info-bearing sources are unsupported.');
  const transactionStructure = parseClassicPdfStructure(sourceBytes);
  const request = normalizeRequest(requestValue, sourceBytes); const pages = collectPages(structure); const page = pages[request.page - 1]; if (!page) unsupported();
  const geometry = [request.rect.x, request.rect.y, request.rect.x + request.rect.width, request.rect.y + request.rect.height];
  if (geometry[0] < page.crop[0] || geometry[1] < page.crop[1] || geometry[2] > page.crop[2] || geometry[3] > page.crop[3]) unsupported('Placement must be contained by the page CropBox.');
  const plan = resourcePlan(page); const content = Buffer.from(`q ${request.rect.width} 0 0 ${request.rect.height} ${request.rect.x} ${request.rect.y} cm /${plan.name} Do Q\n`, 'latin1');
  const contents = page.entries.get('Contents'); const contentRefs = contents === undefined ? [] : contents.type === 'ref' ? [ref(contents)] : contents.type === 'array' ? contents.values.map((entry) => ref(entry)) : null;
  if (!contentRefs || new Set(contentRefs.map(refText)).size !== contentRefs.length) unsupported('The page content graph is ambiguous.');
  const pageValue = pdfDict([...page.entries, ['Resources', plan.resources], ['Contents', pdfArray([...contentRefs, plan.contentRef])]]);
  const transaction = planClassicObjectTransaction({ sourceBytes, sourceStructure: transactionStructure, updates: [{ reference: page.reference, value: pageValue }], additions: [{ id: 'jpeg-image', value: pdfDict([['Type', pdfName('XObject')], ['Subtype', pdfName('Image')], ['Width', pdfNumber(request.jpeg.width)], ['Height', pdfNumber(request.jpeg.height)], ['ColorSpace', pdfName(request.jpeg.components === 1 ? 'DeviceGray' : 'DeviceRGB')], ['BitsPerComponent', pdfNumber(8)], ['Filter', pdfName('DCTDecode')], ['Length', pdfNumber(request.jpeg.bytes.length)]]), streamBytes: request.jpeg.bytes }, { id: 'jpeg-content', value: pdfDict([['Length', pdfNumber(content.length)]]), streamBytes: content }], info: { kind: 'preserve' }, changingId: null });
  const bytes = Buffer.concat([sourceBytes, transaction.revision.bytes]); const proof = Object.freeze({ profile: PDF_JPEG_IMAGE_PROFILE, sourceSha256: request.sourceSha256, page: request.page, rect: request.rect, image: Object.freeze({ width: request.jpeg.width, height: request.jpeg.height, components: request.jpeg.components, bytes: request.jpeg.bytes.length, sha256: request.jpeg.sha256 }), resourceName: plan.name, sourcePrefixPreserved: true, existingContentPreserved: true, existingResourcesPreserved: true, otherPagesUnchanged: true, placementMatrix: Object.freeze([request.rect.width, 0, 0, request.rect.height, request.rect.x, request.rect.y]), contentSha256: digest(content) });
  return Object.freeze({ bytes, proof, request, structure, page, plan, content, transaction });
}

function inspect(sourceBytes, outputBytes, requestValue, expectedProof) {
  const expected = build(sourceBytes, requestValue); if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(expected.bytes)) invalidOutput();
  const output = parsePdfStructure(outputBytes); if (output.revisions.length !== 2 || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) invalidOutput();
  const page = dict(resolvePdfObject(output, expected.page.reference).value); const resources = dict(page.get('Resources')); const xObject = dict(resources.get('XObject')); const image = resolvePdfObject(output, ref(xObject.get(expected.plan.name))); const imageEntries = dict(image.value);
  if (image.streamLength !== expected.request.jpeg.bytes.length || !outputBytes.subarray(image.streamStart, image.streamStart + image.streamLength).equals(expected.request.jpeg.bytes) || imageEntries.get('Filter')?.value !== 'DCTDecode' || pdfInteger(imageEntries.get('Width')) !== expected.request.jpeg.width || pdfInteger(imageEntries.get('Height')) !== expected.request.jpeg.height) invalidOutput();
  if (expectedProof && JSON.stringify(expectedProof) !== JSON.stringify(expected.proof)) invalidOutput();
  return expected.proof;
}

export function writePdfJpegImage(sourceBytes, request) { const result = build(sourceBytes, request); inspect(sourceBytes, result.bytes, request, result.proof); return Object.freeze({ bytes: result.bytes, proof: result.proof }); }
export function inspectPdfJpegImage(sourceBytes, outputBytes, request, expectedProof = undefined) { return inspect(sourceBytes, outputBytes, request, expectedProof); }
export const writePdfJpegImageInsertion = writePdfJpegImage;
export const inspectPdfJpegImageInsertion = inspectPdfJpegImage;
