import { createHash } from 'node:crypto';
import { effectiveEntriesMatch, incrementalCompatibilityEvidence, trailerMatches } from './pdf-incremental-verification.mjs';
import { copyPdfReference, pdfReferenceText, samePdfReference } from './pdf-incremental-reference.mjs';
import { serializedIncrementalObjectValue } from './pdf-incremental-object-value.mjs';
import { validateIncrementalRoleObjects } from './pdf-incremental-role-validation.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS,
  parseClassicPdfStructure,
  parsePdfStructure,
  resolvePdfObject,
} from './pdf-classic-structure.mjs';
import { normalizeClassicPdfObjectValue } from './pdf-classic-object-value.mjs';
import { validatePdfDeletionReferences } from './pdf-incremental-deletion-validation.mjs';

const MAX_APPEND_BYTES = 1024 * 1024;
const MAX_OFFSET = 9_999_999_999;
const genericDescriptors = new WeakSet();
const classicDescriptors = new WeakSet();
const classicGenericDescriptors = new WeakMap();
const recordStreams = new WeakMap();
const recordObjects = new WeakMap();

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalid() { return failure('INVALID_CLASSIC_INCREMENTAL_REVISION', 'The classic incremental revision request is invalid.'); }

function limitExceeded() { return failure('CLASSIC_INCREMENTAL_LIMIT_EXCEEDED', 'The classic incremental revision exceeds its fixed safety limits.'); }

function invalidOutput() { return failure('INVALID_CLASSIC_INCREMENTAL_OUTPUT', 'The classic incremental revision failed structural verification.'); }

export function checkedIncrementalSource(sourceBytes, sourceStructure) {
  const buffer = sourceStructure
    && Object.getOwnPropertyDescriptor(sourceStructure, 'buffer')?.value;
  const revisions = sourceStructure
    && Object.getOwnPropertyDescriptor(sourceStructure, 'revisions')?.value;
  const effective = sourceStructure
    && Object.getOwnPropertyDescriptor(sourceStructure, 'effective')?.value;
  if (!Buffer.isBuffer(sourceBytes) || buffer !== sourceBytes
    || !Array.isArray(revisions) || !(effective instanceof Map)) throw invalid();
  return parsePdfStructure(sourceBytes);
}

function recordValues(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (!Object.hasOwn(descriptors, 'reference') || !Object.hasOwn(descriptors, 'value')
    || keys.some((key) => !['reference', 'streamBytes', 'value'].includes(key))
    || Object.values(descriptors).some((descriptor) => (
      !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
    ))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function recordArray(value, allowEmpty = false) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < (allowEmpty ? 0 : 1)
    || length > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries
    || Object.keys(descriptors).length !== length + 1) throw invalid();
  const records = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true) throw invalid();
    records.push(descriptor.value);
  }
  return records;
}

export function normalizedIncrementalRecords(
  structure, records, effectiveSize, allowEmpty = false,
) {
  const values = recordArray(records, allowEmpty);
  if (!Number.isSafeInteger(effectiveSize) || effectiveSize < structure.finalSize
    || effectiveSize >= CLASSIC_PDF_STRUCTURE_LIMITS.maxObjectNumber) throw invalid();
  const prepared = [];
  let retainedBytes = 1;
  for (const record of values) {
    const { reference, value, streamBytes } = recordValues(record);
    const serialized = serializedIncrementalObjectValue(value, streamBytes);
    const normalizedReference = copyPdfReference(reference);
    retainedBytes += Buffer.byteLength(serialized.body, 'latin1')
      + (serialized.streamBytes?.length ?? 0)
      + Buffer.byteLength(pdfReferenceText(normalizedReference), 'latin1') + 36;
    if (retainedBytes > MAX_APPEND_BYTES) throw limitExceeded();
    const preparedRecord = Object.freeze({
      reference: normalizedReference,
      body: serialized.body,
      nestedReferences: serialized.references,
      streamLength: serialized.streamBytes?.length ?? null,
      streamSha256: serialized.streamBytes
        ? createHash('sha256').update(serialized.streamBytes).digest('hex')
        : null,
    });
    recordStreams.set(preparedRecord, serialized.streamBytes);
    recordObjects.set(preparedRecord, Object.freeze({
      value: serialized.value, stream: serialized.streamBytes !== null,
    }));
    prepared.push(preparedRecord);
  }
  for (let index = 0; index < prepared.length; index += 1) {
    const current = prepared[index].reference;
    if (index > 0 && prepared[index - 1].reference.object >= current.object) throw invalid();
    if (structure.controlObjectNumbers?.has(current.object)) throw invalid();
    if (current.object < structure.finalSize) {
      const existing = structure.effective.get(current.object);
      if (!existing || !['n', 'c'].includes(existing.status)
        || existing.generation !== current.generation) throw invalid();
    } else if (current.generation !== 0) throw invalid();
  }
  const additions = prepared.filter(({ reference }) => reference.object >= structure.finalSize);
  if (effectiveSize !== structure.finalSize + additions.length
    || additions.some(({ reference }, index) => (
      reference.object !== structure.finalSize + index
    ))) throw invalid();
  const written = new Set(prepared.map(({ reference }) => pdfReferenceText(reference)));
  for (const record of prepared) {
    for (const reference of record.nestedReferences) {
      const existing = structure.effective.get(reference.object);
      const resolvesExisting = ['n', 'c'].includes(existing?.status)
        && existing.generation === reference.generation;
      if (!resolvesExisting && !written.has(pdfReferenceText(reference))) throw invalid();
    }
  }
  return Object.freeze(prepared.map((record) => {
    const result = Object.freeze({
      reference: record.reference,
      body: record.body,
      streamLength: record.streamLength,
      streamSha256: record.streamSha256,
    });
    recordStreams.set(result, recordStreams.get(record));
    recordObjects.set(result, recordObjects.get(record));
    return result;
  }));
}

export function checkedIncrementalInfoReference(structure, records, value) {
  if (value === null) {
    if (structure.info !== null) throw invalid();
    return null;
  }
  const reference = copyPdfReference(value);
  if (samePdfReference(reference, structure.info)) return reference;
  const created = records.some(({ reference: candidate }) => (
    candidate.object >= structure.finalSize && samePdfReference(candidate, reference)
  ));
  if (!created) throw invalid();
  return reference;
}

export function incrementalChangingIdHex(structure, changingId) {
  if (structure.id === null) {
    if (changingId !== null) throw invalid();
    return null;
  }
  if (!Buffer.isBuffer(changingId) || changingId.length !== 16) throw invalid();
  return changingId.toString('hex').toUpperCase();
}

function framedIncrementalRecord(record, offset) {
  const streamBytes = recordStreams.get(record) ?? null;
  if ((streamBytes === null) !== (record.streamLength === null)
    || (streamBytes && (streamBytes.length !== record.streamLength
      || createHash('sha256').update(streamBytes).digest('hex') !== record.streamSha256))) throw invalid();
  const header = Buffer.from(`${record.reference.object} ${record.reference.generation} obj\n${record.body}`, 'latin1');
  const tail = Buffer.from(streamBytes ? '\nstream\n' : '\n', 'latin1');
  const end = Buffer.from(streamBytes ? '\nendstream\nendobj\n' : 'endobj\n', 'latin1');
  const framedRecord = Object.freeze({ ...record, offset });
  recordStreams.set(framedRecord, streamBytes);
  return {
    chunks: streamBytes ? [header, tail, streamBytes, end] : [header, tail, end],
    length: header.length + tail.length + (streamBytes?.length ?? 0) + end.length,
    record: framedRecord,
  };
}

export function incrementalRevisionBytes(
  sourceBytes, structure, records, effectiveSize, infoReference, idHex,
) {
  const objectChunks = [Buffer.from('\n', 'latin1')];
  let objectsLength = 1;
  const framed = [];
  for (const record of records) {
    const offset = sourceBytes.length + objectsLength;
    if (offset > MAX_OFFSET) throw limitExceeded();
    const frame = framedIncrementalRecord(record, offset);
    objectChunks.push(...frame.chunks);
    objectsLength += frame.length;
    if (objectsLength > MAX_APPEND_BYTES) throw limitExceeded();
    framed.push(frame.record);
  }
  const xrefOffset = sourceBytes.length + objectsLength;
  if (xrefOffset > MAX_OFFSET) throw limitExceeded();
  let xref = 'xref\n';
  for (const record of framed) {
    xref += `${record.reference.object} 1\n${String(record.offset).padStart(10, '0')} ${String(record.reference.generation).padStart(5, '0')} n \n`;
  }
  const info = infoReference ? ` /Info ${pdfReferenceText(infoReference)}` : '';
  const id = idHex
    ? ` /ID [<${structure.id[0].toString('hex').toUpperCase()}> <${idHex}>]`
    : '';
  const trailer = `<< /Size ${effectiveSize} /Root ${pdfReferenceText(structure.root)}${info}${id} /Prev ${structure.revisions[0].offset} >>`;
  const suffix = Buffer.from(
    `${xref}trailer\n${trailer}\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1',
  );
  const bytes = Buffer.concat([...objectChunks, suffix]);
  if (bytes.length > MAX_APPEND_BYTES) throw limitExceeded();
  return Object.freeze({ bytes, records: Object.freeze(framed), xrefOffset });
}

export function buildPdfIncrementalRevision({
  sourceBytes,
  sourceStructure,
  records,
  effectiveSize,
  infoReference,
  changingId,
} = {}) {
  try {
    const structure = checkedIncrementalSource(sourceBytes, sourceStructure);
    const normalized = normalizedIncrementalRecords(structure, records, effectiveSize);
    const sourceRows = structure.revisions.reduce(
      (total, revision) => total + revision.entries.length,
      0,
    );
    if (structure.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions
      || sourceRows + normalized.length
        > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw limitExceeded();
    const info = checkedIncrementalInfoReference(structure, normalized, infoReference);
    validateIncrementalRoleObjects(
      structure,
      normalized,
      normalized.map((record) => recordObjects.get(record)),
      info,
    );
    const idHex = incrementalChangingIdHex(structure, changingId);
    const frame = incrementalRevisionBytes(
      sourceBytes, structure, normalized, effectiveSize, info, idHex,
    );
    const descriptor = Object.freeze({
      bytes: frame.bytes,
      records: frame.records,
      xrefOffset: frame.xrefOffset,
      previousXrefOffset: structure.revisions[0].offset,
      effectiveSize,
      infoReference: info,
      changingIdHex: idHex,
      idPolicy: structure.id
        ? 'permanent-preserved-changing-updated'
        : 'absent',
    });
    genericDescriptors.add(descriptor);
    return descriptor;
  } catch (error) {
    if (['INVALID_CLASSIC_INCREMENTAL_REVISION', 'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED']
      .includes(error?.code)) throw error;
    throw invalid();
  }
}

export function validateIncrementalDeletionRecords(structure, targets, records) {
  const replacements = records.map((record) => Object.freeze({
    reference: record.reference, value: recordObjects.get(record).value,
  }));
  validatePdfDeletionReferences(structure, targets, replacements);
}

export function validateIncrementalRecordRoles(structure, records, info) {
  validateIncrementalRoleObjects(
    structure, records, records.map((record) => recordObjects.get(record)), info,
  );
}

function writtenXrefEntryMatchesRecord(entry, record) {
  return entry.object === record.reference.object
    && entry.generation === record.reference.generation
    && entry.offset === record.offset
    && entry.status === 'n';
}

function writtenObjectMatchesRecord(output, record, object) {
  const normalized = normalizeClassicPdfObjectValue(object.value);
  const streamBytes = recordStreams.get(record) ?? null;
  if (normalized.body !== record.body) return false;
  if (object.stream !== (streamBytes !== null)) return false;
  if (object.streamLength !== (streamBytes?.length ?? 0)) return false;
  return streamBytes === null || output.buffer.subarray(
    object.streamStart, object.streamStart + object.streamLength,
  ).equals(streamBytes);
}

export function verifyIncrementalWrittenRecords(output, records, entriesByObject) {
  records.forEach((record, index) => {
    const entry = entriesByObject?.get(record.reference.object)
      ?? output.revisions[0].entries[index];
    if (!writtenXrefEntryMatchesRecord(entry, record)) throw invalidOutput();
    const object = resolvePdfObject(output, record.reference);
    if (!writtenObjectMatchesRecord(output, record, object)) throw invalidOutput();
    const normalized = normalizeClassicPdfObjectValue(object.value);
    for (const reference of normalized.references) resolvePdfObject(output, reference);
  });
}

function verifyRevisionRecords(output, expected) {
  const entries = output.revisions[0].entries;
  if (entries.length !== expected.records.length) throw invalidOutput();
  verifyIncrementalWrittenRecords(output, expected.records);
}

export function verifyPdfIncrementalRevision({
  sourceBytes,
  outputBytes,
  sourceStructure,
  expectedRevision,
} = {}) {
  try {
    const source = checkedIncrementalSource(sourceBytes, sourceStructure);
    if (!genericDescriptors.has(expectedRevision) || !Buffer.isBuffer(outputBytes)) throw invalidOutput();
    const rebuilt = incrementalRevisionBytes(
      sourceBytes,
      source,
      expectedRevision.records,
      expectedRevision.effectiveSize,
      expectedRevision.infoReference,
      expectedRevision.changingIdHex,
    );
    if (!expectedRevision.bytes.equals(rebuilt.bytes)
      || outputBytes.length !== sourceBytes.length + rebuilt.bytes.length
      || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)
      || !outputBytes.subarray(sourceBytes.length).equals(rebuilt.bytes)) throw invalidOutput();
    const output = parsePdfStructure(outputBytes);
    if (!trailerMatches(source, output, expectedRevision)) throw invalidOutput();
    verifyRevisionRecords(output, expectedRevision);
    if (!effectiveEntriesMatch(source, output, expectedRevision)) throw invalidOutput();
    return Object.freeze({
      outputStructure: output,
      sourcePrefixPreserved: true,
      unchangedObjectOffsetsPreserved: true,
      rootPreserved: true,
      infoReferenceVerified: true,
      ...incrementalCompatibilityEvidence(source, expectedRevision),
      idPolicy: expectedRevision.idPolicy,
    });
  } catch (error) {
    if (error?.code === 'INVALID_CLASSIC_INCREMENTAL_OUTPUT') throw error;
    throw invalidOutput();
  }
}

export function brandClassicIncrementalRevision(generic) {
  if (!genericDescriptors.has(generic)) throw invalid();
  const classic = Object.freeze({ ...generic });
  classicDescriptors.add(classic);
  classicGenericDescriptors.set(classic, generic);
  return classic;
}

export function classicRevisionGeneric(classic) { return classicDescriptors.has(classic) ? classicGenericDescriptors.get(classic) : null; }

function strictClassicSource(sourceBytes, sourceStructure) {
  parseClassicPdfStructure(sourceBytes);
  if (Object.getOwnPropertyDescriptor(sourceStructure ?? {}, 'buffer')?.value !== sourceBytes
    || Object.getOwnPropertyDescriptor(sourceStructure ?? {}, 'xrefFlavor') !== undefined) throw invalid();
}

export function buildClassicIncrementalRevision(request = {}) {
  try {
    strictClassicSource(request.sourceBytes, request.sourceStructure);
    return brandClassicIncrementalRevision(buildPdfIncrementalRevision(request));
  } catch (error) {
    if (['INVALID_CLASSIC_INCREMENTAL_REVISION', 'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED'].includes(error?.code)) throw error;
    throw invalid();
  }
}

export function verifyClassicIncrementalRevision(request = {}) {
  try {
    strictClassicSource(request.sourceBytes, request.sourceStructure);
    const generic = classicRevisionGeneric(request.expectedRevision);
    if (!generic) throw invalidOutput();
    const proof = verifyPdfIncrementalRevision({ ...request, expectedRevision: generic });
    return Object.freeze({ ...proof, outputStructure: parseClassicPdfStructure(request.outputBytes) });
  } catch (error) {
    if (error?.code === 'INVALID_CLASSIC_INCREMENTAL_OUTPUT') throw error;
    throw invalidOutput();
  }
}
