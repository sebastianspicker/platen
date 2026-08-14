import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { basename, extname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  pdfDictionary, pdfReference, serializePdfValue,
} from './pdf-classic-syntax.mjs';
import { parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import {
  PDF_FILE_AUDIO_ATTACHMENT_PROFILE,
  normalizePdfFileAudioAttachment,
  pdfFileAudioAttachmentFailure,
} from './pdf-file-audio-attachment-contract.mjs';

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_ANNOTATIONS = 100;
const PASSIVE_ANNOTATIONS = new Set([
  'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine',
  'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink',
]);
const REJECTED_KEYS = new Set([
  'A', 'AA', 'AcroForm', 'AF', 'ByteRange', 'Collection', 'Dest', 'EmbeddedFiles',
  'EF', 'Encrypt', 'JS', 'Launch', 'Metadata', 'Names', 'OCProperties', 'OpenAction',
  'Outlines', 'Perms', 'RichMediaContent', 'Sound', 'StructParent', 'StructParents',
  'StructTreeRoot', 'SubmitForm', 'URI', 'XFA', 'FT',
]);
const REJECTED_TYPES = new Set(['EmbeddedFile', 'Filespec', 'Metadata', 'Sig', 'ObjStm', 'XRef']);
const REJECTED_SUBTYPES = new Set(['FileAttachment', 'Sound', 'Movie', 'Screen', 'RichMedia', '3D', 'Widget']);
const descriptors = new WeakSet();
const states = new WeakMap();

function invalid() { return pdfFileAudioAttachmentFailure(); }
function invalidOutput() {
  const error = new Error('PDF file/audio attachment output is invalid.');
  error.code = 'INVALID_PDF_FILE_AUDIO_ATTACHMENT_OUTPUT';
  return error;
}
function same(left, right) { return left.object === right.object && left.generation === right.generation; }
function refText(value) { return `${value.object} ${value.generation} R`; }
function name(value) { return Object.freeze({ type: 'name', value }); }
function number(value) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw: String(value) }); }
function string(bytes) { return Object.freeze({ type: 'string', format: 'hex', bytes: Buffer.from(bytes) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function validatePcmWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') throw invalid();
  if (bytes.readUInt32LE(4) !== bytes.length - 8) throw invalid();
  let offset = 12; let fmt = null; let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4); offset += 8;
    if (length > bytes.length - offset) throw invalid();
    const chunk = bytes.subarray(offset, offset + length);
    if (id === 'fmt ' && fmt === null) fmt = chunk;
    if (id === 'data' && data === null) data = chunk;
    offset += length + (length % 2);
    if (offset > bytes.length) throw invalid();
  }
  if (offset !== bytes.length || !fmt || fmt.length < 16 || !data || data.length < 1) throw invalid();
  const audioFormat = fmt.readUInt16LE(0); const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4); const byteRate = fmt.readUInt32LE(8);
  const blockAlign = fmt.readUInt16LE(12); const bits = fmt.readUInt16LE(14);
  if (audioFormat !== 1 || channels < 1 || channels > 8 || sampleRate < 1 || sampleRate > 192000
    || ![8, 16, 24, 32].includes(bits) || blockAlign !== channels * (bits / 8)
    || byteRate !== sampleRate * blockAlign || data.length % blockAlign !== 0) throw invalid();
  return Object.freeze({ channels, sampleRate, bitsPerSample: bits, dataBytes: data.length });
}

function sourceStructure(sourceBytes) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 5 || sourceBytes.length > MAX_SOURCE_BYTES
    || (typeof SharedArrayBuffer !== 'undefined' && sourceBytes.buffer instanceof SharedArrayBuffer)) throw invalid();
  let structure;
  try { structure = parsePdfStructure(sourceBytes); } catch { throw invalid(); }
  if (structure.revisions.length !== 1 || structure.revisions[0].trailer.has('Prev') || structure.revisions[0].trailer.has('Encrypt')
    || structure.controlObjectNumbers?.size || [...structure.effective.values()].some((entry) => entry.status === 'c')) throw invalid();
  return structure;
}

function scanObject(value, seen = new Set()) {
  if (value?.type === 'array') { value.values.forEach((entry) => scanObject(entry, seen)); return; }
  if (value?.type !== 'dict') return;
  const type = value.entries.get('Type'); const subtype = value.entries.get('Subtype');
  if ((type?.type === 'name' && REJECTED_TYPES.has(type.value))
    || (subtype?.type === 'name' && REJECTED_SUBTYPES.has(subtype.value))
    || [...REJECTED_KEYS].some((key) => value.entries.has(key))
    || value.entries.has('S')) throw invalid();
  value.entries.forEach((entry) => scanObject(entry, seen));
}

function directBox(value) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry?.type !== 'number' || !Number.isFinite(entry.value))) throw invalid();
  const box = value.values.map((entry) => entry.value);
  if (!(box[0] < box[2] && box[1] < box[3])) throw invalid();
  return Object.freeze(box);
}
function pageTree(structure) {
  const catalog = resolvePdfObject(structure, structure.root); const catalogEntries = pdfDictionary(catalog.value);
  if (catalogEntries.get('Type')?.value !== 'Catalog' || [...catalogEntries.keys()].some((key) => !['Type', 'Pages'].includes(key))) throw invalid();
  const pagesReference = pdfReference(catalogEntries.get('Pages')); const pages = []; const seen = new Set();
  function visit(reference, parent, depth) {
    if (depth > 16 || seen.has(refText(reference))) throw invalid(); seen.add(refText(reference));
    const object = resolvePdfObject(structure, reference); if (object.stream) throw invalid(); const entries = pdfDictionary(object.value);
    const type = entries.get('Type')?.value; if (!['Page', 'Pages'].includes(type)) throw invalid();
    if (parent === null ? entries.has('Parent') : !same(pdfReference(entries.get('Parent')), parent)) throw invalid();
    if (type === 'Page') {
      const mediaBox = directBox(entries.get('MediaBox')); const cropBox = entries.has('CropBox') ? directBox(entries.get('CropBox')) : mediaBox;
      if (mediaBox[0] > cropBox[0] || mediaBox[1] > cropBox[1] || mediaBox[2] < cropBox[2] || mediaBox[3] < cropBox[3]) throw invalid();
      const annotsValue = entries.get('Annots'); let annotations = [];
      if (annotsValue !== undefined) {
        const annots = annotsValue.type === 'ref' ? resolvePdfObject(structure, annotsValue).value : annotsValue;
        if (annots?.type !== 'array' || annots.values.length > MAX_ANNOTATIONS) throw invalid();
        annotations = annots.values.map((entry) => pdfReference(entry));
        if (new Set(annotations.map(refText)).size !== annotations.length) throw invalid();
        for (const annotation of annotations) {
          const value = resolvePdfObject(structure, annotation); if (value.stream || value.value?.type !== 'dict') throw invalid();
          const ad = pdfDictionary(value.value); const subtype = ad.get('Subtype')?.value;
          if (ad.get('Type')?.value !== 'Annot' || !PASSIVE_ANNOTATIONS.has(subtype)) throw invalid();
        }
      }
      pages.push(Object.freeze({ reference, entries, mediaBox, cropBox, annotations, annotsReference: annotsValue?.type === 'ref' ? pdfReference(annotsValue) : null })); return;
    }
    const kids = entries.get('Kids'); if (kids?.type !== 'array' || kids.values.length < 1) throw invalid();
    const count = entries.get('Count'); if (count?.type !== 'number' || !Number.isSafeInteger(count.value) || count.value !== kids.values.length) throw invalid();
    kids.values.forEach((kid) => visit(pdfReference(kid), reference, depth + 1));
  }
  visit(pagesReference, null, 0); if (pages.length < 1 || pages.length > MAX_PAGES) throw invalid(); return Object.freeze({ catalog, pages });
}

function state(sourceBytes) {
  const structure = sourceStructure(sourceBytes);
  for (const entry of structure.effective.values()) {
    if (entry.status !== 'n') continue;
    const object = resolvePdfObject(structure, { type: 'ref', object: entry.object, generation: entry.generation });
    if (!object.stream) scanObject(object.value);
  }
  return Object.freeze({ structure, ...pageTree(structure) });
}

function attachmentValues(attachment, references) {
  const safeName = Buffer.from(attachment.displayName, 'utf8');
  return {
    embedded: dict([['Type', name('EmbeddedFile')], ['Subtype', name(attachment.mediaType)], ['Length', number(attachment.bytes.length)]]),
    filespec: dict([['Type', name('Filespec')], ['F', string(safeName)], ['UF', string(safeName)], ['EF', dict([['F', references.embedded]])]]),
  };
}

function canonicalAppend(sourceBytes, source, target, request, attachment) {
  try {
    const embeddedRef = { type: 'ref', object: source.structure.finalSize, generation: 0 };
    const filespecRef = { type: 'ref', object: source.structure.finalSize + 1, generation: 0 };
    const annotationRef = { type: 'ref', object: source.structure.finalSize + 2, generation: 0 };
    const values = attachmentValues(attachment, { embedded: embeddedRef });
    const annotation = dict([
      ['Type', name('Annot')], ['Subtype', name('FileAttachment')],
      ['Rect', array([number(request.rect.x), number(request.rect.y), number(request.rect.x + request.rect.width), number(request.rect.y + request.rect.height)])],
      ['FS', filespecRef], ['Name', name('PushPin')],
    ]);
    const annots = [...target.annotations, annotationRef];
    const updates = target.annotsReference
      ? [{ reference: target.annotsReference, value: array(annots) }]
      : [{ reference: target.reference, value: dict([...target.entries, ['Annots', array(annots)]]) }];
    const transaction = planPdfObjectTransaction({
      sourceBytes, sourceStructure: source.structure, updates,
      additions: [
        { id: 'embedded', value: values.embedded, streamBytes: attachment.bytes },
        { id: 'filespec', value: dict([...values.filespec.entries, ['EF', dict([['F', embeddedRef]])]]) },
        { id: 'annotation', value: annotation },
      ], info: { kind: 'preserve' },
      changingId: source.structure.id ? createHash('sha256').update('Platen file/audio attachment ID v1\0').update(sourceBytes).update(JSON.stringify(request)).digest().subarray(0, 16) : null,
    });
    if (!same(transaction.referencesById.embedded, embeddedRef) || !same(transaction.referencesById.filespec, filespecRef) || !same(transaction.referencesById.annotation, annotationRef)) throw invalid();
    return Object.freeze({ revision: transaction.revision, bytes: transaction.revision.bytes, annotationRef, filespecRef, embeddedRef, updatedRef: updates[0].reference });
  } catch { throw invalid(); }
}

function target(source, request) {
  const selected = source.pages[request.page - 1]; if (!selected) throw invalid();
  const [left, bottom, right, top] = [request.rect.x, request.rect.y, request.rect.x + request.rect.width, request.rect.y + request.rect.height];
  if (left < selected.cropBox[0] || bottom < selected.cropBox[1] || right > selected.cropBox[2] || top > selected.cropBox[3]) throw invalid();
  return selected;
}

function proof(sourceBytes, outputBytes, append, source, request, attachment) {
  return Object.freeze({
    profile: PDF_FILE_AUDIO_ATTACHMENT_PROFILE, sourceBytes: sourceBytes.length, outputBytes: outputBytes.length,
    appendedBytes: outputBytes.length - sourceBytes.length, sourcePrefixPreserved: true, revisionCount: 2,
    page: request.page, rect: request.rect, mediaType: attachment.mediaType, extension: attachment.extension,
    assetSha256: attachment.sha256, attachmentAnnotationObjectNumber: append.annotationRef.object,
    filespecObjectNumber: append.filespecRef.object, embeddedFileObjectNumber: append.embeddedRef.object,
    sourcePageObjectNumber: source.pages[request.page - 1].reference.object,
    annotationCount: source.pages[request.page - 1].annotations.length + 1,
    rootPreserved: true, infoPreserved: true, noActions: true, noRichMedia: true, noAutoplay: true,
  });
}

function inspectWithSource(sourceBytes, outputBytes, request, attachment) {
  try {
    const source = state(sourceBytes); const selected = target(source, request);
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const append = canonicalAppend(sourceBytes, source, selected, request, attachment);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: source.structure, expectedRevision: append.revision }).outputStructure;
    if (output.revisions.length !== 2 || !same(output.root, source.structure.root) || output.finalSize !== source.structure.finalSize + 3) throw invalidOutput();
    const outObject = resolvePdfObject(output, append.annotationRef); const ad = pdfDictionary(outObject.value);
    if (ad.get('Subtype')?.value !== 'FileAttachment' || !same(pdfReference(ad.get('FS')), append.filespecRef) || ad.has('A') || ad.has('AA') || ad.has('RichMediaContent')) throw invalidOutput();
    const fs = pdfDictionary(resolvePdfObject(output, append.filespecRef).value); const ef = pdfDictionary(fs.get('EF')); const embedded = resolvePdfObject(output, pdfReference(ef.get('F')));
    if (!embedded.stream || embedded.streamLength !== attachment.bytes.length
      || !output.buffer.subarray(embedded.streamStart, embedded.streamStart + embedded.streamLength).equals(attachment.bytes)) throw invalidOutput();
    return proof(sourceBytes, outputBytes, append, source, request, attachment);
  } catch (error) { if (error?.code === 'INVALID_PDF_FILE_AUDIO_ATTACHMENT_OUTPUT') throw error; throw invalidOutput(); }
}

function checkedAttachment(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 5
    || Object.keys(value).sort().join(',') !== 'bytes,displayName,extension,mediaType,sha256'
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
    || !Buffer.isBuffer(value.bytes) || (typeof SharedArrayBuffer !== 'undefined' && value.bytes.buffer instanceof SharedArrayBuffer)
    || value.bytes.length < 1 || value.bytes.length > MAX_ATTACHMENT_BYTES
    || typeof value.displayName !== 'string' || !/^[\x20-\x7e]{1,240}$/u.test(value.displayName)
    || basename(value.displayName) !== value.displayName || value.displayName.includes('\\')
    || typeof value.mediaType !== 'string' || typeof value.extension !== 'string' || typeof value.sha256 !== 'string') throw invalid();
  if (value.mediaType === 'audio/wav') validatePcmWav(value.bytes);
  if (!['text/plain', 'application/octet-stream', 'audio/wav'].includes(value.mediaType)
    || !['.txt', '.bin', '.wav'].includes(value.extension)
    || extname(value.displayName).toLowerCase() !== value.extension
    || sha(value.bytes) !== value.sha256) throw invalid();
  return Object.freeze({ bytes: Buffer.from(value.bytes), displayName: value.displayName, mediaType: value.mediaType, extension: value.extension, sha256: value.sha256 });
}

export function writePdfFileAudioAttachment(sourceBytes, requestValue, attachmentValue) {
  try {
    const request = normalizePdfFileAudioAttachment(requestValue); const attachment = checkedAttachment(attachmentValue); const source = state(sourceBytes);
    if (request.sourceSha256 !== sha(sourceBytes)) throw invalid();
    const selected = target(source, request);
    if (attachment.mediaType !== request.mediaType || attachment.extension !== request.extension) throw invalid();
    const append = canonicalAppend(sourceBytes, source, selected, request, attachment); const bytes = Buffer.concat([sourceBytes, append.bytes]);
    const result = Object.freeze({ bytes, proof: inspectWithSource(sourceBytes, bytes, request, attachment) }); descriptors.add(result); states.set(result, Object.freeze({ sourceSha256: sha(sourceBytes), request, attachment })); return result;
  } catch (error) { if (error?.code === 'INVALID_PDF_FILE_AUDIO_ATTACHMENT_OUTPUT') throw error; throw invalid(); }
}

export function inspectPdfFileAudioAttachment(sourceBytes, outputBytes, requestValue, expected) {
  try {
    const request = normalizePdfFileAudioAttachment(requestValue); const stateValue = states.get(expected);
    if (!descriptors.has(expected) || !stateValue || stateValue.sourceSha256 !== sha(sourceBytes)
      || !isDeepStrictEqual(stateValue.request, request)) throw invalid();
    return inspectWithSource(sourceBytes, outputBytes, request, stateValue.attachment);
  } catch { throw invalidOutput(); }
}

export const writePdfFileAttachment = writePdfFileAudioAttachment;
export const inspectPdfFileAttachment = inspectPdfFileAudioAttachment;
