import { createHash } from 'node:crypto';
import {
  pdfDictionary,
  pdfInteger,
  serializePdfValue,
} from './pdf-classic-syntax.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS,
  parsePdfStructure,
  resolvePdfObject,
} from './pdf-classic-structure.mjs';
import {
  planPdfObjectTransaction,
} from './pdf-classic-object-transaction.mjs';
import {
  verifyPdfIncrementalRevision,
} from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import {
  INCREMENTAL_METADATA_PROFILE,
  normalizeIncrementalMetadata,
} from './pdf-incremental-metadata-contract.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';

const PDF_FIELDS = Object.freeze([
  ['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['keywords', 'Keywords'],
]);
function failure(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function unsupported() {
  return failure('UNSUPPORTED_INCREMENTAL_METADATA_PDF', 'PDF is not in the supported bounded incremental-object form.');
}

function invalidOutput() {
  return failure('INVALID_INCREMENTAL_METADATA_OUTPUT', 'Incremental metadata output proof failed.');
}

function noChange() {
  return failure('INVALID_INCREMENTAL_METADATA', 'Incremental PDF metadata would not change the canonical Info dictionary.');
}

function sameReference(left, right) {
  return left.object === right.object && left.generation === right.generation;
}

function containsMetadataEntry(value) {
  if (value?.type === 'array') return value.values.some(containsMetadataEntry);
  if (value?.type !== 'dict') return false;
  return value.entries.has('Metadata') || [...value.entries.values()].some(containsMetadataEntry);
}

function parseStructure(buffer) {
  try {
    const structure = parsePdfStructure(buffer);
    visitPdfObjects(structure, (object) => {
      if (containsMetadataEntry(object.value)) throw unsupported();
      if (!object.stream || object.value.type !== 'dict') return;
      if (object.value.entries.get('Length')?.type === 'ref') throw unsupported();
      const type = object.value.entries.get('Type'); const subtype = object.value.entries.get('Subtype');
      if ((type?.type === 'name' && (type.value === 'Metadata'
        || (['ObjStm', 'XRef'].includes(type.value)
          && !structure.controlObjectNumbers?.has(object.reference.object))))
        || (subtype?.type === 'name' && subtype.value === 'XML')) throw unsupported();
    });
    if (structure.info) {
      const infoObject = resolvePdfObject(structure, structure.info);
      if (infoObject.stream === true) throw unsupported();
      pdfDictionary(infoObject.value);
    }
    return Object.freeze(structure);
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_INCREMENTAL_METADATA_PDF') throw error;
    throw unsupported();
  }
}

function expectedInfo(structure, metadata) {
  const entries = structure.info
    ? new Map(pdfDictionary(resolvePdfObject(structure, structure.info).value)) : new Map();
  for (const [, pdfName] of PDF_FIELDS) entries.delete(pdfName);
  for (const [name, pdfName] of PDF_FIELDS) if (metadata[name] !== null) entries.set(pdfName, pdfUtf16BeString(metadata[name]));
  return Object.freeze({ type: 'dict', entries });
}

function mutationBytes(metadata) {
  return Buffer.from(JSON.stringify(PDF_FIELDS.map(([name, pdfName]) => [pdfName, metadata[name]])), 'utf8');
}

function changedId(source, metadata) {
  const digest = createHash('sha256').update(source).digest();
  return createHash('sha256')
    .update('Platen incremental metadata ID v1\0', 'utf8')
    .update(digest).update(mutationBytes(metadata)).digest().subarray(0, 16);
}

function canonicalAppend(source, structure, metadata) {
  const infoObjectNumber = structure.finalSize;
  const infoValue = expectedInfo(structure, metadata);
  const infoBody = serializePdfValue(infoValue);
  const currentInfoBody = structure.info
    ? serializePdfValue(resolvePdfObject(structure, structure.info).value) : serializePdfValue({ type: 'dict', entries: new Map() });
  if (infoBody === currentInfoBody) throw noChange();
  try {
    const transaction = planPdfObjectTransaction({
      sourceBytes: source,
      sourceStructure: structure,
      updates: [],
      additions: [{ id: 'info', value: infoValue }],
      info: { kind: 'set', additionId: 'info' },
      changingId: structure.id ? changedId(source, metadata) : null,
    });
    const revision = transaction.revision;
    if (transaction.referencesById.info.object !== infoObjectNumber) throw unsupported();
    return Object.freeze({
      revision,
      bytes: revision.bytes,
      infoObjectNumber,
      objectOffset: revision.records[0].offset,
      xrefOffset: revision.xrefOffset,
    });
  } catch {
    throw unsupported();
  }
}

function buildProof(source, outputStructure, append, sourceStructure, idPolicy) {
  return Object.freeze({
    profile: INCREMENTAL_METADATA_PROFILE,
    sourceBytes: source.length,
    outputBytes: outputStructure.buffer.length,
    appendedBytes: append.bytes.length,
    sourcePrefixPreserved: true,
    priorObjectOffsetsPreserved: true,
    revisionCount: outputStructure.revisions.length,
    previousXrefOffset: sourceStructure.revisions[0].offset,
    appendedXrefOffset: append.xrefOffset,
    infoObjectNumber: append.infoObjectNumber,
    infoGeneration: 0,
    effectiveSize: append.infoObjectNumber + 1,
    rootPreserved: true,
    idPolicy,
    metadataFieldCount: 4,
  });
}

function inspectWithSource(sourceBytes, outputBytes, metadata, source) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length
      || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const append = canonicalAppend(sourceBytes, source, metadata);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({
      sourceBytes,
      outputBytes,
      sourceStructure: source,
      expectedRevision: append.revision,
    }).outputStructure;
    if (output.revisions.length !== source.revisions.length + 1
      || output.revisions[0].offset !== append.xrefOffset
      || pdfInteger(output.revisions[0].trailer.get('Prev')) !== source.revisions[0].offset
      || output.finalSize !== append.infoObjectNumber + 1
      || !sameReference(output.root, source.root)
      || output.info.object !== append.infoObjectNumber || output.info.generation !== 0
      || serializePdfValue(resolvePdfObject(output, output.info).value) !== serializePdfValue(expectedInfo(source, metadata))) throw invalidOutput();
    const idPolicy = source.id ? 'permanent-preserved-changing-updated' : 'absent';
    if ((source.id === null) !== (output.id === null)
      || (source.id && (!output.id[0].equals(source.id[0]) || !output.id[1].equals(changedId(sourceBytes, metadata))))) throw invalidOutput();
    return buildProof(sourceBytes, output, append, source, idPolicy);
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_METADATA') throw error;
    throw invalidOutput();
  }
}

export function inspectIncrementalPdfMetadata(sourceBytes, outputBytes, expectedMetadata) {
  const metadata = normalizeIncrementalMetadata(expectedMetadata);
  const source = parseStructure(sourceBytes);
  return inspectWithSource(sourceBytes, outputBytes, metadata, source);
}

export function writeIncrementalPdfMetadata(sourceBytes, metadataValue) {
  const metadata = normalizeIncrementalMetadata(metadataValue);
  const source = parseStructure(sourceBytes);
  const sourceEntryCount = source.revisions.reduce((total, revision) => total + revision.entries.length, 0);
  if (source.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions
    || sourceEntryCount >= CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported();
  const append = canonicalAppend(sourceBytes, source, metadata);
  const bytes = Buffer.concat([sourceBytes, append.bytes]);
  const proof = inspectWithSource(sourceBytes, bytes, metadata, source);
  return Object.freeze({ bytes, proof });
}
