import { createHash } from 'node:crypto';
import {
  effectiveEntriesMatch,
  incrementalCompatibilityEvidence,
  trailerMatches,
} from './pdf-incremental-verification.mjs';
import { pdfReferenceText, samePdfReference } from './pdf-incremental-reference.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS,
  parseClassicPdfStructure,
  parsePdfStructure,
  resolvePdfObject,
} from './pdf-classic-structure.mjs';
import {
  admittedPdfDeletions,
  validatePdfDeletionFreeList,
  validatePdfDeletionReferences,
} from './pdf-incremental-deletion-validation.mjs';
import {
  checkedIncrementalInfoReference,
  checkedIncrementalSource,
  incrementalChangingIdHex,
  incrementalRevisionBytes,
  normalizedIncrementalRecords,
  validateIncrementalDeletionRecords,
  validateIncrementalRecordRoles,
  verifyIncrementalWrittenRecords,
} from './pdf-classic-incremental-revision.mjs';

const MAX_APPEND_BYTES = 1024 * 1024;
const deletionDescriptors = new WeakSet();
const deletionStates = new WeakMap();
const classicDeletionDescriptors = new WeakMap();

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalid() {
  return failure(
    'INVALID_CLASSIC_INCREMENTAL_REVISION',
    'The classic incremental revision request is invalid.',
  );
}

function limitExceeded() {
  return failure(
    'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED',
    'The classic incremental revision exceeds its fixed safety limits.',
  );
}

function invalidOutput() {
  return failure(
    'INVALID_CLASSIC_INCREMENTAL_OUTPUT',
    'The classic incremental revision failed structural verification.',
  );
}

function sharedBuffer(value) {
  return typeof SharedArrayBuffer !== 'undefined'
    && Buffer.isBuffer(value)
    && value.buffer instanceof SharedArrayBuffer;
}

function xrefRowsText(rows) {
  let result = 'xref\n';
  let index = 0;
  while (index < rows.length) {
    let end = index + 1;
    while (end < rows.length && rows[end].object === rows[end - 1].object + 1) end += 1;
    result += `${rows[index].object} ${end - index}\n`;
    for (let row = index; row < end; row += 1) {
      result += `${String(rows[row].offset).padStart(10, '0')} ${String(rows[row].generation).padStart(5, '0')} ${rows[row].status} \n`;
    }
    index = end;
  }
  return result;
}

function deletionFrame(
  sourceBytes, structure, records, effectiveSize, targets, freeList, infoReference, idHex,
) {
  const objects = incrementalRevisionBytes(
    sourceBytes, structure, records, effectiveSize, infoReference, idHex,
  );
  const xrefAt = objects.xrefOffset - sourceBytes.length;
  if (!Number.isSafeInteger(xrefAt) || xrefAt < 1 || xrefAt > objects.bytes.length) {
    throw invalid();
  }
  const prefix = objects.bytes.subarray(0, xrefAt);
  const rows = [
    Object.freeze({
      kind: 'free', object: 0, generation: 65_535,
      status: 'f', offset: targets[0].object,
    }),
    ...targets.map((target, index) => Object.freeze({
      kind: 'free',
      object: target.object,
      generation: target.generation + 1,
      status: 'f',
      offset: index + 1 < targets.length ? targets[index + 1].object : freeList.head,
    })),
    ...objects.records.map((record) => Object.freeze({
      kind: 'write',
      object: record.reference.object,
      generation: record.reference.generation,
      status: 'n',
      offset: record.offset,
    })),
  ].sort((left, right) => left.object - right.object);
  if (rows.some((row, rowIndex) => (
    rowIndex > 0 && rows[rowIndex - 1].object === row.object
  ))) throw invalid();
  const info = infoReference ? ` /Info ${pdfReferenceText(infoReference)}` : '';
  const id = idHex
    ? ` /ID [<${structure.id[0].toString('hex').toUpperCase()}> <${idHex}>]`
    : '';
  const xrefOffset = sourceBytes.length + prefix.length;
  const suffix = Buffer.from(
    `${xrefRowsText(rows)}trailer\n<< /Size ${effectiveSize} /Root ${pdfReferenceText(structure.root)}${info}${id} /Prev ${structure.revisions[0].offset} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'latin1',
  );
  const bytes = Buffer.concat([prefix, suffix]);
  if (bytes.length > MAX_APPEND_BYTES) throw limitExceeded();
  return Object.freeze({
    bytes,
    records: objects.records,
    xrefOffset,
    rows: Object.freeze(rows),
  });
}

export function buildPdfDeletionIncrementalRevision({
  sourceBytes,
  sourceStructure,
  records = [],
  effectiveSize,
  infoReference,
  changingId,
  deletionAdmission,
} = {}) {
  try {
    if (sharedBuffer(sourceBytes)) throw invalid();
    const structure = checkedIncrementalSource(sourceBytes, sourceStructure);
    const admission = admittedPdfDeletions(deletionAdmission, sourceStructure);
    const freeList = validatePdfDeletionFreeList(structure);
    const targets = admission.targets.map((target) => {
      const entry = structure.effective.get(target.object);
      if (!entry || entry.status !== 'n' || entry.generation !== target.generation
        || target.generation > 65_534 || structure.controlObjectNumbers?.has(target.object)
        || samePdfReference(target, structure.root)
        || samePdfReference(target, structure.info)) throw invalid();
      return Object.freeze({ ...target });
    });
    const normalized = normalizedIncrementalRecords(
      structure, records, effectiveSize, true,
    );
    if (targets.length + normalized.length > 10_000
      || normalized.some((record) => targets.some((target) => (
        target.object === record.reference.object
      )))) throw invalid();
    validateIncrementalDeletionRecords(structure, targets, normalized);
    const info = checkedIncrementalInfoReference(structure, normalized, infoReference);
    validateIncrementalRecordRoles(structure, normalized, info);
    const sourceRows = structure.revisions.reduce(
      (total, revision) => total + revision.entries.length, 0,
    );
    if (structure.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions
      || sourceRows + normalized.length + targets.length + 1
        > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw limitExceeded();
    const idHex = incrementalChangingIdHex(structure, changingId);
    const frame = deletionFrame(
      sourceBytes, structure, normalized, effectiveSize, targets, freeList, info, idHex,
    );
    const deletions = Object.freeze(targets.map((target, index) => Object.freeze({
      reference: target,
      freeGeneration: target.generation + 1,
      nextFree: index + 1 < targets.length ? targets[index + 1].object : freeList.head,
    })));
    const descriptor = Object.freeze({
      bytes: frame.bytes,
      records: frame.records,
      xrefRows: frame.rows,
      xrefOffset: frame.xrefOffset,
      previousXrefOffset: structure.revisions[0].offset,
      effectiveSize,
      infoReference: info,
      changingIdHex: idHex,
      idPolicy: structure.id ? 'permanent-preserved-changing-updated' : 'absent',
      deletions,
      freeListHeadBefore: freeList.head,
      freeListHeadAfter: targets[0].object,
      deletionCount: targets.length,
    });
    deletionDescriptors.add(descriptor);
    deletionStates.set(descriptor, Object.freeze({
      targets: Object.freeze(targets),
      freeList: Object.freeze({ ...freeList }),
      sourceLength: admission.sourceLength,
      sourceSha256: admission.sourceSha256,
    }));
    return descriptor;
  } catch (error) {
    if (error?.code === 'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED') throw error;
    throw invalid();
  }
}

function rebuiltMatches(expected, rebuilt, sourceBytes, outputBytes) {
  return expected.bytes.equals(rebuilt.bytes)
    && expected.xrefOffset === rebuilt.xrefOffset
    && expected.xrefRows.length === rebuilt.rows.length
    && !expected.xrefRows.some((row, index) => (
      row.object !== rebuilt.rows[index].object
      || row.generation !== rebuilt.rows[index].generation
      || row.status !== rebuilt.rows[index].status
      || row.offset !== rebuilt.rows[index].offset
    ))
    && outputBytes.length === sourceBytes.length + rebuilt.bytes.length
    && outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)
    && outputBytes.subarray(sourceBytes.length).equals(rebuilt.bytes);
}

function verifyXrefRows(output, expected) {
  const entries = output.revisions[0].entries;
  if (entries.length !== expected.xrefRows.length) throw invalidOutput();
  const entriesByObject = new Map();
  expected.xrefRows.forEach((row, index) => {
    const entry = entries[index];
    if (!entry || entry.object !== row.object || entry.generation !== row.generation
      || entry.status !== row.status || entry.offset !== row.offset
      || entriesByObject.has(entry.object)) throw invalidOutput();
    entriesByObject.set(entry.object, entry);
  });
  return entriesByObject;
}

function verifyDeletedEntries(output, expected) {
  for (const deletion of expected.deletions) {
    const entry = output.effective.get(deletion.reference.object);
    if (!entry || entry.status !== 'f'
      || entry.generation !== deletion.freeGeneration
      || entry.offset !== deletion.nextFree) throw invalidOutput();
    for (const reference of [
      deletion.reference,
      Object.freeze({
        type: 'ref',
        object: deletion.reference.object,
        generation: deletion.freeGeneration,
      }),
    ]) {
      let rejected = false;
      try { resolvePdfObject(output, reference); } catch { rejected = true; }
      if (!rejected) throw invalidOutput();
    }
  }
}

export function verifyPdfDeletionIncrementalRevision({
  sourceBytes,
  outputBytes,
  sourceStructure,
  expectedRevision,
} = {}) {
  try {
    const state = deletionStates.get(expectedRevision);
    if (!deletionDescriptors.has(expectedRevision) || !state
      || !Buffer.isBuffer(sourceBytes) || !Buffer.isBuffer(outputBytes)
      || sharedBuffer(sourceBytes)
      || sourceBytes.length !== state.sourceLength
      || createHash('sha256').update(sourceBytes).digest('hex') !== state.sourceSha256) {
      throw invalidOutput();
    }
    const source = checkedIncrementalSource(sourceBytes, sourceStructure);
    const rebuilt = deletionFrame(
      sourceBytes,
      source,
      expectedRevision.records,
      expectedRevision.effectiveSize,
      state.targets,
      state.freeList,
      expectedRevision.infoReference,
      expectedRevision.changingIdHex,
    );
    if (!rebuiltMatches(expectedRevision, rebuilt, sourceBytes, outputBytes)) {
      throw invalidOutput();
    }
    const output = parsePdfStructure(outputBytes);
    if (!trailerMatches(source, output, expectedRevision)) throw invalidOutput();
    const entriesByObject = verifyXrefRows(output, expectedRevision);
    verifyIncrementalWrittenRecords(output, expectedRevision.records, entriesByObject);
    verifyDeletedEntries(output, expectedRevision);
    const zero = output.effective.get(0);
    if (!zero || zero.status !== 'f' || zero.generation !== 65_535
      || zero.offset !== expectedRevision.freeListHeadAfter) throw invalidOutput();
    const freeList = validatePdfDeletionFreeList(output);
    if (freeList.head !== expectedRevision.freeListHeadAfter
      || freeList.freeCount !== state.freeList.freeCount + expectedRevision.deletionCount) {
      throw invalidOutput();
    }
    validatePdfDeletionReferences(output, state.targets);
    if (!effectiveEntriesMatch(source, output, expectedRevision)) throw invalidOutput();
    return Object.freeze({
      outputStructure: output,
      sourcePrefixPreserved: true,
      unchangedObjectOffsetsPreserved: true,
      rootPreserved: true,
      infoReferenceVerified: true,
      freeListVerified: true,
      deletedReferencesUnresolvable: true,
      ...incrementalCompatibilityEvidence(source, expectedRevision),
      idPolicy: expectedRevision.idPolicy,
    });
  } catch (error) {
    if (error?.code === 'INVALID_CLASSIC_INCREMENTAL_OUTPUT') throw error;
    throw invalidOutput();
  }
}

export function brandClassicDeletionIncrementalRevision(generic) {
  if (!deletionDescriptors.has(generic)) throw invalid();
  const classic = Object.freeze({ ...generic });
  classicDeletionDescriptors.set(classic, generic);
  return classic;
}

function strictClassicSource(sourceBytes, sourceStructure) {
  parseClassicPdfStructure(sourceBytes);
  if (Object.getOwnPropertyDescriptor(sourceStructure ?? {}, 'buffer')?.value !== sourceBytes
    || Object.getOwnPropertyDescriptor(sourceStructure ?? {}, 'xrefFlavor') !== undefined) {
    throw invalid();
  }
}

export function verifyClassicDeletionIncrementalRevision(request = {}) {
  try {
    strictClassicSource(request.sourceBytes, request.sourceStructure);
    const generic = classicDeletionDescriptors.get(request.expectedRevision);
    if (!generic) throw invalidOutput();
    const proof = verifyPdfDeletionIncrementalRevision({
      ...request, expectedRevision: generic,
    });
    return Object.freeze({
      ...proof,
      outputStructure: parseClassicPdfStructure(request.outputBytes),
    });
  } catch (error) {
    if (error?.code === 'INVALID_CLASSIC_INCREMENTAL_OUTPUT') throw error;
    throw invalidOutput();
  }
}
