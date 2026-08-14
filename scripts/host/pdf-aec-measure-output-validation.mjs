import { createHash } from 'node:crypto';
import { pdfInteger, serializePdfValue } from './pdf-classic-syntax.mjs';
import { resolvePdfObject } from './pdf-classic-structure.mjs';

function sameReference(left, right) {
  return left.object === right.object && left.generation === right.generation;
}

export function invalidAecMeasureOutput() {
  const error = new Error('The incremental AEC measure-dictionary output proof failed.');
  error.code = 'INVALID_AEC_MEASURE_DICTIONARY_OUTPUT';
  return error;
}

export function changedAecMeasureId(source, input) {
  return createHash('sha256')
    .update('Platen AEC Measure dictionary ID v1\0', 'utf8')
    .update(createHash('sha256').update(source).digest())
    .update(JSON.stringify(input), 'utf8')
    .digest().subarray(0, 16);
}

export function validateAecOutputEnvelope(sourceBytes, outputBytes) {
  if (!Buffer.isBuffer(outputBytes)) throw invalidAecMeasureOutput();
  if (outputBytes.length <= sourceBytes.length) throw invalidAecMeasureOutput();
  if (!outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) {
    throw invalidAecMeasureOutput();
  }
}

function validateAecRevisionTopology(source, output, append) {
  if (output.revisions.length !== source.revisions.length + 1) throw invalidAecMeasureOutput();
  validateAecRevisionBindings(source, output, append, output.revisions[0]);
  validateAecRetainedReferences(source, output, append, output.revisions[0]);
}

function validateAecRevisionBindings(source, output, append, revision) {
  if (revision.offset !== append.xrefOffset) throw invalidAecMeasureOutput();
  if (pdfInteger(revision.trailer.get('Prev')) !== source.revisions[0].offset) {
    throw invalidAecMeasureOutput();
  }
  if (output.finalSize !== source.finalSize + 2) throw invalidAecMeasureOutput();
  if (!sameReference(output.root, source.root)) throw invalidAecMeasureOutput();
}

function validateAecRetainedReferences(source, output, append, revision) {
  if ((source.info === null) !== (output.info === null)) throw invalidAecMeasureOutput();
  if (source.info && !sameReference(output.info, source.info)) throw invalidAecMeasureOutput();
  if (revision.entries.length !== append.records.length) throw invalidAecMeasureOutput();
}

function validateAecAppendedRecords(output, append) {
  append.records.forEach((record, index) => {
    const entry = output.revisions[0].entries[index];
    validateAecAppendedEntry(entry, record.reference, append.offsets[index]);
    validateAecAppendedValue(output, record);
  });
}

function validateAecAppendedEntry(entry, reference, expectedOffset) {
  if (entry.object !== reference.object) throw invalidAecMeasureOutput();
  if (entry.generation !== reference.generation) throw invalidAecMeasureOutput();
  if (entry.offset !== expectedOffset) throw invalidAecMeasureOutput();
  if (entry.status !== 'n') throw invalidAecMeasureOutput();
}

function validateAecAppendedValue(output, record) {
  const actual = serializePdfValue(resolvePdfObject(output, record.reference).value);
  if (actual !== serializePdfValue(record.value)) throw invalidAecMeasureOutput();
}

function validateAecEffectiveEntries(source, output, append) {
  const replaced = new Set(append.records.map((record) => record.reference.object));
  for (const [number, entry] of source.effective) {
    const next = output.effective.get(number);
    if (!next) throw invalidAecMeasureOutput();
    if (!replaced.has(number)) validateAecEffectiveEntry(entry, next);
  }
}

function validateAecEffectiveEntry(entry, next) {
  if (next.generation !== entry.generation) throw invalidAecMeasureOutput();
  if (next.status !== entry.status) throw invalidAecMeasureOutput();
  if (entry.status === 'c') {
    if (next.objectStream !== entry.objectStream) throw invalidAecMeasureOutput();
    if (next.index !== entry.index) throw invalidAecMeasureOutput();
    return;
  }
  if (next.offset !== entry.offset) throw invalidAecMeasureOutput();
}

function validateAecPermanentId(source, output, sourceBytes, input) {
  if ((source.id === null) !== (output.id === null)) throw invalidAecMeasureOutput();
  if (!source.id) return;
  if (!output.id[0].equals(source.id[0])) throw invalidAecMeasureOutput();
  if (!output.id[1].equals(changedAecMeasureId(sourceBytes, input))) {
    throw invalidAecMeasureOutput();
  }
}

export function validateAecParsedOutput({
  source, output, append, sourceBytes, input,
}) {
  validateAecRevisionTopology(source, output, append);
  validateAecAppendedRecords(output, append);
  validateAecEffectiveEntries(source, output, append);
  validateAecPermanentId(source, output, sourceBytes, input);
  return output;
}
