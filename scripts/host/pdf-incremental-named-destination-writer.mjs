import { createHash } from 'node:crypto';
import { pdfDictionary, pdfInteger, pdfReference } from './pdf-classic-syntax.mjs';
import { CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import { INCREMENTAL_NAMED_DESTINATION_PROFILE, normalizeIncrementalNamedDestination } from './pdf-incremental-named-destination-contract.mjs';

const CATALOG_REJECTED = new Set(['Dests', 'OpenAction', 'AA', 'AcroForm', 'AF', 'Collection', 'Metadata', 'Outlines', 'Perms', 'URI']);
const UNSAFE_KEYS = new Set([
  'A', 'AA', 'AcroForm', 'ByteRange', 'Dur', 'EF', 'EmbeddedFiles', 'FS', 'JS',
  'Next', 'OpenAction', 'PresSteps', 'Trans', 'URI', 'XFA',
]);

function error(code, message) { const result = new Error(message); result.code = code; return result; }
function unsupported() { return error('UNSUPPORTED_INCREMENTAL_NAMED_DESTINATION_PDF', 'PDF is outside the supported bounded incremental named-destination subset.'); }
function invalidOutput() { return error('INVALID_INCREMENTAL_NAMED_DESTINATION_OUTPUT', 'Incremental named-destination output proof failed.'); }
function sameReference(left, right) { return left.object === right.object && left.generation === right.generation; }
function referenceKey(reference) { return `${reference.object}:${reference.generation}`; }
function pdfName(value) { return Object.freeze({ type: 'name', value }); }
function pdfString(value) { return Object.freeze({ type: 'string', format: 'literal', bytes: Buffer.from(value, 'ascii') }); }
function pdfArray(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function pdfDict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }

function parseSource(bytes) {
  if (!Buffer.isBuffer(bytes) || (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)) throw unsupported();
  try { return parsePdfStructure(bytes); } catch { throw unsupported(); }
}

function directIntegerBox(value) {
  if (value?.type !== 'array' || value.values.length !== 4
    || value.values.some((entry) => entry.type !== 'number' || !entry.integer)) throw unsupported();
  const box = value.values.map((entry) => entry.value);
  if (box[0] >= box[2] || box[1] >= box[3]) throw unsupported();
  return Object.freeze(box);
}

function contains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1]
    && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function rejectUnsafeValue(value) {
  if (value?.type === 'array') {
    for (const entry of value.values) rejectUnsafeValue(entry);
    return;
  }
  if (value?.type !== 'dict') return;
  const entries = value.entries;
  const type = entries.get('Type');
  const subtype = entries.get('Subtype');
  if (entries.has('FT') || entries.has('S')
    || [...UNSAFE_KEYS].some((key) => entries.has(key))
    || type?.type === 'name'
      && ['Action', 'Metadata', 'Sig', 'EmbeddedFile', 'Filespec'].includes(type.value)
    || subtype?.type === 'name' && subtype.value === 'Widget') throw unsupported();
  for (const entry of entries.values()) rejectUnsafeValue(entry);
}

function rejectUnsafeObjects(structure) {
  visitPdfObjects(structure, (object) => {
    if (object.value?.type !== 'dict') return;
    const entries = object.value.entries;
    const type = entries.get('Type');
    const subtype = entries.get('Subtype');
    const control = structure.controlObjectNumbers?.has(object.reference.object)
      && type?.type === 'name' && ['XRef', 'ObjStm'].includes(type.value);
    if (control) return;
    if (object.stream) {
      const length = entries.get('Length');
      if (length?.type !== 'number' || !length.integer || length.value < 0
        || length.value !== object.streamLength) throw unsupported();
    }
    rejectUnsafeValue(object.value);
  });
}

function collectPages(structure) {
  try {
    const catalog = resolvePdfObject(structure, structure.root);
    if (catalog.stream) throw unsupported();
    const root = pdfDictionary(catalog.value);
    if (root.get('Type')?.type !== 'name' || root.get('Type').value !== 'Catalog'
      || [...CATALOG_REJECTED].some((key) => root.has(key))) throw unsupported();
    rejectUnsafeObjects(structure);
    const pagesReference = pdfReference(root.get('Pages'));
    const pages = resolvePdfObject(structure, pagesReference);
    if (pages.stream) throw unsupported();
    const pagesEntries = pdfDictionary(pages.value);
    const kids = pagesEntries.get('Kids');
    if (pagesEntries.get('Type')?.value !== 'Pages' || pagesEntries.has('Parent')
      || kids?.type !== 'array' || kids.values.length < 1 || kids.values.length > 100
      || pdfInteger(pagesEntries.get('Count')) !== kids.values.length) throw unsupported();
    const references = kids.values.map((value) => pdfReference(value));
    if (new Set(references.map(referenceKey)).size !== references.length) throw unsupported();
    for (const reference of references) {
      const page = resolvePdfObject(structure, reference);
      if (page.stream) throw unsupported();
      const entries = pdfDictionary(page.value);
      if (entries.get('Type')?.value !== 'Page' || entries.has('Annots')
        || !sameReference(pdfReference(entries.get('Parent')), pagesReference)) throw unsupported();
      const mediaBox = directIntegerBox(entries.get('MediaBox'));
      const cropBox = directIntegerBox(entries.get('CropBox'));
      if (!contains(mediaBox, cropBox)) throw unsupported();
    }
    return Object.freeze({ catalog, root, references: Object.freeze(references) });
  } catch (cause) {
    if (cause?.code === 'UNSUPPORTED_INCREMENTAL_NAMED_DESTINATION_PDF') throw cause;
    throw unsupported();
  }
}

function changedId(sourceBytes, request) {
  return createHash('sha256').update('Platen incremental named destination ID v1\0')
    .update(createHash('sha256').update(sourceBytes).digest())
    .update(JSON.stringify(request)).digest().subarray(0, 16);
}

function append(sourceBytes, structure, state, request) {
  try {
    const target = state.references[request.targetPage - 1];
    if (!target || state.root.has('Names')) throw unsupported();
    const names = pdfDict([['Dests', pdfDict([['Names', pdfArray([
      pdfString(request.name), pdfArray([target, pdfName('Fit')]),
    ])]])]]);
    const root = pdfDict([...state.root, ['Names', names]]);
    const transaction = planPdfObjectTransaction({
      sourceBytes,
      sourceStructure: structure,
      updates: [{ reference: structure.root, value: root }],
      additions: [],
      info: { kind: 'preserve' },
      changingId: structure.id ? changedId(sourceBytes, request) : null,
    });
    return Object.freeze({ revision: transaction.revision, bytes: transaction.revision.bytes });
  } catch { throw unsupported(); }
}

function proof(sourceBytes, output, request, target, idPolicy) {
  return Object.freeze({
    profile: INCREMENTAL_NAMED_DESTINATION_PROFILE,
    sourceBytes: sourceBytes.length,
    outputBytes: output.buffer.length,
    sourcePrefixPreserved: true,
    revisionCount: output.revisions.length,
    previousXrefOffset: output.revisions[1].offset,
    appendedXrefOffset: output.revisions[0].offset,
    targetPage: request.targetPage,
    targetPageObjectNumber: target.object,
    targetPageGeneration: target.generation,
    nameSha256: createHash('sha256').update(request.name, 'ascii').digest('hex'),
    effectiveSize: output.finalSize,
    rootPreserved: true,
    infoPreserved: true,
    idPolicy,
  });
}

function inspect(sourceBytes, outputBytes, request, structure, state) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length
      || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const built = append(sourceBytes, structure, state, request);
    if (!outputBytes.subarray(sourceBytes.length).equals(built.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({
      sourceBytes, outputBytes, sourceStructure: structure, expectedRevision: built.revision,
    }).outputStructure;
    const root = pdfDictionary(resolvePdfObject(output, output.root).value);
    const names = root.get('Names')?.entries?.get('Dests')?.entries?.get('Names');
    const target = state.references[request.targetPage - 1];
    if (output.revisions.length !== structure.revisions.length + 1
      || output.revisions[0].entries.length !== 1
      || output.revisions[0].entries[0].object !== structure.root.object
      || output.finalSize !== structure.finalSize || !sameReference(output.root, structure.root)
      || Boolean(output.info) !== Boolean(structure.info)
      || output.info && !sameReference(output.info, structure.info)
      || names?.type !== 'array' || names.values.length !== 2
      || names.values[0]?.type !== 'string'
      || !names.values[0].bytes.equals(Buffer.from(request.name, 'ascii'))
      || names.values[1]?.type !== 'array' || names.values[1].values.length !== 2
      || !sameReference(pdfReference(names.values[1].values[0]), target)
      || names.values[1].values[1]?.type !== 'name' || names.values[1].values[1].value !== 'Fit') throw invalidOutput();
    for (const [number, entry] of structure.effective) {
      const after = output.effective.get(number);
      if (!after || number !== structure.root.object && (after.status !== entry.status
        || after.generation !== entry.generation || after.offset !== entry.offset)) throw invalidOutput();
    }
    const idPolicy = structure.id ? 'permanent-preserved-changing-updated' : 'absent';
    if ((structure.id === null) !== (output.id === null) || structure.id
      && (!output.id[0].equals(structure.id[0])
        || !output.id[1].equals(changedId(sourceBytes, request)))) throw invalidOutput();
    return proof(sourceBytes, output, request, target, idPolicy);
  } catch (cause) {
    if (cause?.code === 'INVALID_INCREMENTAL_NAMED_DESTINATION_OUTPUT') throw cause;
    throw invalidOutput();
  }
}

export function inspectIncrementalPdfNamedDestination(sourceBytes, outputBytes, requestValue) {
  const request = normalizeIncrementalNamedDestination(requestValue);
  const structure = parseSource(sourceBytes);
  return inspect(sourceBytes, outputBytes, request, structure, collectPages(structure));
}

export function writeIncrementalPdfNamedDestination(sourceBytes, requestValue) {
  const request = normalizeIncrementalNamedDestination(requestValue);
  const structure = parseSource(sourceBytes);
  const state = collectPages(structure);
  const rows = structure.revisions.reduce((total, revision) => total + revision.entries.length, 0);
  if (structure.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions
    || rows + 1 > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported();
  const built = append(sourceBytes, structure, state, request);
  const bytes = Buffer.concat([sourceBytes, built.bytes]);
  return Object.freeze({ bytes, proof: inspect(sourceBytes, bytes, request, structure, state) });
}
