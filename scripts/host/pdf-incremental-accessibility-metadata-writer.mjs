import { createHash } from 'node:crypto';
import { pdfDictionary, pdfInteger, serializePdfValue } from './pdf-classic-syntax.mjs';
import { CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, normalizeIncrementalAccessibilityMetadata } from './pdf-incremental-accessibility-metadata-contract.mjs';

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported() { return failure('UNSUPPORTED_INCREMENTAL_ACCESSIBILITY_METADATA_PDF', 'PDF is outside the supported bounded incremental accessibility metadata subset.'); }
function invalidOutput() { return failure('INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT', 'Incremental accessibility metadata output proof failed.'); }
function sameReference(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }

const FORBIDDEN_KEYS = new Set([
  'A', 'AA', 'AcroForm', 'AF', 'Annots', 'ByteRange', 'Collection', 'Dests',
  'Dur', 'EF', 'EmbeddedFiles', 'FS', 'JS', 'Metadata', 'Names', 'Next', 'OC',
  'OCGs', 'OCProperties', 'OpenAction', 'Outlines', 'PA', 'Perms', 'PresSteps',
  'RichMediaContent', 'StructTreeRoot', 'Trans', 'URI', 'XFA', '3DD',
]);
const ACTIVE_ACTIONS = new Set([
  'Action', 'GoToE', 'GoToR', 'ImportData', 'JavaScript', 'Launch', 'Rendition',
  'RichMediaExecute', 'SetOCGState', 'Sound', 'SubmitForm', 'URI',
]);
const UNSAFE_TYPES = new Set([
  'Action', 'Annot', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Outlines',
]);
const UNSAFE_SUBTYPES = new Set([
  '3D', 'FileAttachment', 'Movie', 'PS', 'Projection', 'RichMedia', 'Screen',
  'Sound', 'XML',
]);

function containsForbiddenSurface(value) {
  if (value?.type === 'array') return value.values.some(containsForbiddenSurface);
  if (value?.type !== 'dict') return false;
  if ([...value.entries.keys()].some((key) => FORBIDDEN_KEYS.has(key))) return true;
  const type = value.entries.get('Type'); const action = value.entries.get('S');
  const subtype = value.entries.get('Subtype');
  if (type?.type === 'name' && (ACTIVE_ACTIONS.has(type.value) || UNSAFE_TYPES.has(type.value))
    || action?.type === 'name' && ACTIVE_ACTIONS.has(action.value)
    || subtype?.type === 'name' && UNSAFE_SUBTYPES.has(subtype.value)) return true;
  return [...value.entries.values()].some(containsForbiddenSurface);
}

function containsMetadata(value) {
  if (value?.type === 'array') return value.values.some(containsMetadata);
  return value?.type === 'dict' && (value.entries.has('Metadata') || [...value.entries.values()].some(containsMetadata));
}

function parseSource(bytes) {
  if (!Buffer.isBuffer(bytes) || (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)) throw unsupported();
  try {
    const structure = parsePdfStructure(bytes);
    visitPdfObjects(structure, (object) => {
      if (containsMetadata(object.value) || containsForbiddenSurface(object.value)) throw unsupported();
      const type = object.value?.entries?.get('Type');
      if (type?.type === 'name' && (type.value === 'Metadata'
        || ['ObjStm', 'XRef'].includes(type.value)
        && !structure.controlObjectNumbers?.has(object.reference.object))) throw unsupported();
    });
    const catalog = resolvePdfObject(structure, structure.root);
    if (catalog.stream) throw unsupported();
    const catalogEntries = pdfDictionary(catalog.value);
    if (catalogEntries.get('Type')?.type !== 'name' || catalogEntries.get('Type').value !== 'Catalog' || catalogEntries.has('Lang')) throw unsupported();
    const pagesReference = catalogEntries.get('Pages');
    if (pagesReference?.type !== 'ref') throw unsupported();
    const pages = resolvePdfObject(structure, pagesReference);
    if (pages.stream || pdfDictionary(pages.value).get('Type')?.value !== 'Pages') throw unsupported();
    if (structure.info) {
      const info = resolvePdfObject(structure, structure.info);
      if (info.stream || pdfDictionary(info.value).has('Title')) throw unsupported();
    }
    return Object.freeze({ structure, catalogEntries });
  } catch (error) { if (error?.code === 'UNSUPPORTED_INCREMENTAL_ACCESSIBILITY_METADATA_PDF') throw error; throw unsupported(); }
}

function changedId(sourceBytes, request) {
  return createHash('sha256').update('Platen incremental accessibility metadata ID v1\0')
    .update(createHash('sha256').update(sourceBytes).digest()).update(JSON.stringify(request)).digest().subarray(0, 16);
}

function expectedCatalog(entries, request) { const result = new Map(entries); result.set('Lang', pdfUtf16BeString(request.language)); return Object.freeze({ type: 'dict', entries: result }); }
function expectedInfo(state, request) {
  const entries = state.structure.info ? new Map(pdfDictionary(resolvePdfObject(state.structure, state.structure.info).value)) : new Map();
  entries.set('Title', pdfUtf16BeString(request.title)); return Object.freeze({ type: 'dict', entries });
}

function append(sourceBytes, state, request) {
  try {
    const transaction = planPdfObjectTransaction({ sourceBytes, sourceStructure: state.structure,
      updates: [{ reference: state.structure.root, value: expectedCatalog(state.catalogEntries, request) }],
      additions: [{ id: 'info', value: expectedInfo(state, request) }], info: { kind: 'set', additionId: 'info' },
      changingId: state.structure.id ? changedId(sourceBytes, request) : null });
    const infoReference = transaction.referencesById.info;
    if (infoReference.object !== state.structure.finalSize) throw unsupported();
    return Object.freeze({ revision: transaction.revision, bytes: transaction.revision.bytes, infoReference, xrefOffset: transaction.revision.xrefOffset });
  } catch { throw unsupported(); }
}

function proof(sourceBytes, output, built, state, idPolicy) { return Object.freeze({
  profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, sourceBytes: sourceBytes.length, outputBytes: output.buffer.length,
  appendedBytes: built.bytes.length, sourcePrefixPreserved: true, priorObjectOffsetsPreserved: true,
  revisionCount: output.revisions.length, previousXrefOffset: state.structure.revisions[0].offset,
  appendedXrefOffset: built.xrefOffset, catalogObjectNumber: state.structure.root.object, catalogGeneration: state.structure.root.generation,
  infoObjectNumber: built.infoReference.object, infoGeneration: 0, effectiveSize: output.finalSize,
  rootPreserved: true, idPolicy,
}); }

function inspectWithSource(sourceBytes, outputBytes, request, state) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const output = parsePdfStructure(outputBytes);
    const newest = output.revisions[0];
    const infoReference = output.info;
    const built = {
      bytes: outputBytes.subarray(sourceBytes.length), infoReference, xrefOffset: newest.offset,
    };
    const catalog = resolvePdfObject(output, output.root); const info = resolvePdfObject(output, output.info);
    const expectedRoot = serializePdfValue(expectedCatalog(state.catalogEntries, request)); const expectedInfoValue = serializePdfValue(expectedInfo(state, request));
    const changedRows = new Map(newest.entries.map((entry) => [entry.object, entry]));
    if (output.revisions.length !== state.structure.revisions.length + 1 || newest.entries.length !== 2
      || newest.offset < sourceBytes.length || pdfInteger(newest.trailer.get('Prev')) !== state.structure.revisions[0].offset
      || output.finalSize !== state.structure.finalSize + 1 || !sameReference(output.root, state.structure.root) || !sameReference(output.info, built.infoReference)
      || infoReference.object !== state.structure.finalSize || infoReference.generation !== 0
      || changedRows.size !== 2 || !changedRows.has(state.structure.root.object)
      || !changedRows.has(infoReference.object)
      || newest.entries.some((entry) => entry.status !== 'n' || entry.offset < sourceBytes.length)
      || serializePdfValue(catalog.value) !== expectedRoot
      || serializePdfValue(info.value) !== expectedInfoValue) throw invalidOutput();
    for (const [number, entry] of state.structure.effective) { const after = output.effective.get(number); if (!after || (number !== state.structure.root.object && (after.status !== entry.status || after.generation !== entry.generation || (entry.status === 'c' ? after.objectStream !== entry.objectStream || after.index !== entry.index : after.offset !== entry.offset)))) throw invalidOutput(); }
    const idPolicy = state.structure.id ? 'permanent-preserved-changing-updated' : 'absent';
    if ((state.structure.id === null) !== (output.id === null) || (state.structure.id && (!output.id[0].equals(state.structure.id[0]) || !output.id[1].equals(changedId(sourceBytes, request))))) throw invalidOutput();
    return proof(sourceBytes, output, built, state, idPolicy);
  } catch (error) { if (error?.code === 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT') throw error; throw invalidOutput(); }
}

export function inspectIncrementalPdfAccessibilityMetadata(sourceBytes, outputBytes, requestValue) { const request = normalizeIncrementalAccessibilityMetadata(requestValue); const state = parseSource(sourceBytes); return inspectWithSource(sourceBytes, outputBytes, request, state); }
export function writeIncrementalPdfAccessibilityMetadata(sourceBytes, requestValue) {
  const request = normalizeIncrementalAccessibilityMetadata(requestValue); const state = parseSource(sourceBytes);
  const rows = state.structure.revisions.reduce((total, revision) => total + revision.entries.length, 0);
  if (state.structure.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions || rows + 2 > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported();
  const built = append(sourceBytes, state, request); const bytes = Buffer.concat([sourceBytes, built.bytes]);
  return Object.freeze({ bytes, proof: inspectWithSource(sourceBytes, bytes, request, state) });
}
