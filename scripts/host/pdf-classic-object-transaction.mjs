import {
  pdfReference,
} from './pdf-classic-syntax.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS,
  parseClassicPdfStructure,
  parsePdfStructure,
} from './pdf-classic-structure.mjs';
import {
  buildPdfIncrementalRevision,
  brandClassicIncrementalRevision,
} from './pdf-classic-incremental-revision.mjs';
import {
  buildPdfDeletionIncrementalRevision,
  brandClassicDeletionIncrementalRevision,
} from './pdf-incremental-deletion-revision.mjs';
import {
  snapshotClassicPdfObjectValue,
} from './pdf-classic-object-value.mjs';
export { authorizePdfObjectDeletion } from './pdf-incremental-deletion-validation.mjs';
import { admitPdfDeletions } from './pdf-incremental-deletion-validation.mjs';

const MAX_TRANSACTION_RECORDS = 10_000;
const ADDITION_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const pendingReferences = new WeakMap();

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalid() {
  return failure(
    'INVALID_CLASSIC_OBJECT_TRANSACTION',
    'The classic PDF object transaction is invalid.',
  );
}

function limitExceeded() {
  return failure(
    'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED',
    'The classic PDF object transaction exceeds its fixed safety limits.',
  );
}

function dataValues(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const allowed = [...required, ...optional].sort();
  if (required.some((key) => !Object.hasOwn(descriptors, key))
    || actual.some((key) => !allowed.includes(key))
    || Object.values(descriptors).some((descriptor) => (
      !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
    ))) throw invalid();
  return Object.fromEntries(actual.map((key) => [key, descriptors[key].value]));
}

function arrayValues(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0) throw invalid();
  if (length > MAX_TRANSACTION_RECORDS) throw limitExceeded();
  if (Object.keys(descriptors).length !== length + 1) throw invalid();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw invalid();
    }
    result.push(descriptor.value);
  }
  return result;
}

function checkedId(value) {
  if (typeof value !== 'string' || !ADDITION_ID.test(value)) throw invalid();
  return value;
}

export function pendingClassicObjectReference(id) {
  const normalized = checkedId(id);
  const handle = Object.freeze({ type: 'pending-ref', id: normalized });
  pendingReferences.set(handle, normalized);
  return handle;
}

export const pendingPdfObjectReference = pendingClassicObjectReference;

function copiedReference(value) {
  const reference = pdfReference(value);
  return Object.freeze({
    type: 'ref',
    object: reference.object,
    generation: reference.generation,
  });
}

function resolvedValue(value, references) {
  try {
    return snapshotClassicPdfObjectValue(value, {
      resolvePending(candidate) {
        const id = pendingReferences.get(candidate);
        if (id === undefined) return undefined;
        const reference = references.get(id);
        if (!reference) throw invalid();
        return reference;
      },
    }).value;
  } catch (error) {
    if (error?.code === 'CLASSIC_PDF_OBJECT_VALUE_LIMIT_EXCEEDED') throw limitExceeded();
    if (error?.code === 'INVALID_CLASSIC_OBJECT_TRANSACTION') throw error;
    throw invalid();
  }
}

function writableValue(value) {
  if (value?.type === 'dict') {
    const type = value.entries.get('Type');
    if (type?.type === 'name' && ['XRef', 'ObjStm'].includes(type.value)) throw invalid();
  }
  return value;
}

function checkedStructure(sourceBytes, sourceStructure) {
  const buffer = sourceStructure
    && Object.getOwnPropertyDescriptor(sourceStructure, 'buffer')?.value;
  const revisions = sourceStructure
    && Object.getOwnPropertyDescriptor(sourceStructure, 'revisions')?.value;
  const effective = sourceStructure
    && Object.getOwnPropertyDescriptor(sourceStructure, 'effective')?.value;
  if (!Buffer.isBuffer(sourceBytes)
    || sourceBytes.buffer instanceof SharedArrayBuffer || buffer !== sourceBytes
    || !Array.isArray(revisions) || !(effective instanceof Map)) throw invalid();
  try {
    return parsePdfStructure(sourceBytes);
  } catch {
    throw invalid();
  }
}

function additionsById(structure, additions) {
  const values = arrayValues(additions);
  if (values.length > MAX_TRANSACTION_RECORDS) throw invalid();
  if (structure.finalSize + values.length
    >= CLASSIC_PDF_STRUCTURE_LIMITS.maxObjectNumber) throw limitExceeded();
  const references = new Map();
  const prepared = values.map((value, index) => {
    const addition = dataValues(value, ['id', 'value'], ['streamBytes']);
    const id = checkedId(addition.id);
    if (references.has(id)) throw invalid();
    references.set(id, Object.freeze({
      type: 'ref',
      object: structure.finalSize + index,
      generation: 0,
    }));
    return addition;
  });
  return Object.freeze({ references, additions: Object.freeze(prepared) });
}

function checkedInfo(info, additions, references) {
  const kind = Object.getOwnPropertyDescriptor(info ?? {}, 'kind')?.value;
  if (kind === 'preserve') { dataValues(info, ['kind']); return null; }
  const values = dataValues(info, ['kind', 'additionId']);
  if (values.kind !== 'set') throw invalid();
  const additionId = checkedId(values.additionId);
  const index = additions.findIndex((addition) => addition.id === additionId);
  if (index < 0 || additions[index].value?.type !== 'dict') throw invalid();
  return references.get(additionId);
}

function referenceRecord(references) {
  const result = Object.create(null);
  for (const [id, reference] of references) result[id] = reference;
  return Object.freeze(result);
}

function preparedTransaction(structure, updates, additions, info, { allowEmpty = false } = {}) {
  const updateValues = arrayValues(updates);
  const prepared = additionsById(structure, additions);
  const { references } = prepared;
  const count = updateValues.length + prepared.additions.length;
  if ((!allowEmpty && count < 1) || count > MAX_TRANSACTION_RECORDS) throw invalid();
  const resolvedUpdates = updateValues.map((value) => {
    const update = dataValues(value, ['reference', 'value'], ['streamBytes']);
    const reference = copiedReference(update.reference);
    if (structure.controlObjectNumbers?.has(reference.object)) throw invalid();
    return Object.freeze({
      reference,
      value: writableValue(resolvedValue(update.value, references)),
      ...(Object.hasOwn(update, 'streamBytes') ? { streamBytes: update.streamBytes } : {}),
    });
  });
  const resolvedAdditions = prepared.additions.map((addition) => Object.freeze({
    reference: references.get(addition.id),
    value: writableValue(resolvedValue(addition.value, references)),
    ...(Object.hasOwn(addition, 'streamBytes') ? { streamBytes: addition.streamBytes } : {}),
  }));
  const records = Object.freeze([...resolvedUpdates, ...resolvedAdditions]
    .sort((left, right) => left.reference.object - right.reference.object));
  const infoReference = checkedInfo(info, resolvedAdditions.map((addition, index) => ({
    id: prepared.additions[index].id, value: addition.value,
  })), references) ?? structure.info;
  return Object.freeze({
    records,
    references,
    referencesById: referenceRecord(references),
    effectiveSize: structure.finalSize + prepared.additions.length,
    infoReference,
    recordCount: count,
  });
}

export function planPdfObjectTransaction(request) {
  try {
    const input = dataValues(request, [
      'sourceBytes', 'sourceStructure', 'updates', 'additions', 'info', 'changingId',
    ]);
    const {
      sourceBytes, sourceStructure, updates, additions, info, changingId,
    } = input;
    const structure = checkedStructure(sourceBytes, sourceStructure);
    const prepared = preparedTransaction(structure, updates, additions, info);
    const revision = buildPdfIncrementalRevision({
      sourceBytes,
      sourceStructure,
      records: prepared.records,
      effectiveSize: prepared.effectiveSize,
      infoReference: prepared.infoReference,
      changingId,
    });
    return Object.freeze({
      revision,
      referencesById: prepared.referencesById,
      effectiveSize: prepared.effectiveSize,
    });
  } catch (error) {
    if (error?.code === 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED') throw error;
    if (error?.code === 'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED') throw limitExceeded();
    if (error?.code === 'INVALID_CLASSIC_OBJECT_TRANSACTION') throw error;
    throw invalid();
  }
}

export function planClassicObjectTransaction(request) {
  try {
    const sourceBytes = request && Object.getOwnPropertyDescriptor(request, 'sourceBytes')?.value;
    const sourceStructure = request && Object.getOwnPropertyDescriptor(request, 'sourceStructure')?.value;
    const buffer = sourceStructure && Object.getOwnPropertyDescriptor(sourceStructure, 'buffer')?.value;
    if (!Buffer.isBuffer(sourceBytes) || buffer !== sourceBytes) throw invalid();
    parseClassicPdfStructure(sourceBytes);
    const generic = planPdfObjectTransaction(request);
    return Object.freeze({ ...generic, revision: brandClassicIncrementalRevision(generic.revision) });
  } catch (error) {
    if (error?.code === 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED') throw error;
    if (error?.code === 'INVALID_CLASSIC_OBJECT_TRANSACTION') throw error;
    throw invalid();
  }
}

export function planPdfObjectDeletionTransaction(request) {
  try {
    const input = dataValues(request, [
      'sourceBytes', 'sourceStructure', 'deletions', 'updates', 'additions',
      'info', 'changingId',
    ]);
    const structure = checkedStructure(input.sourceBytes, input.sourceStructure);
    const deletionHandles = arrayValues(input.deletions);
    const admission = admitPdfDeletions(input.sourceStructure, deletionHandles);
    const prepared = preparedTransaction(
      structure, input.updates, input.additions, input.info, { allowEmpty: true },
    );
    if (deletionHandles.length + prepared.recordCount > MAX_TRANSACTION_RECORDS) {
      throw limitExceeded();
    }
    const revision = buildPdfDeletionIncrementalRevision({
      sourceBytes: input.sourceBytes,
      sourceStructure: input.sourceStructure,
      records: prepared.records,
      effectiveSize: prepared.effectiveSize,
      infoReference: prepared.infoReference,
      changingId: input.changingId,
      deletionAdmission: admission,
    });
    return Object.freeze({
      revision,
      referencesById: prepared.referencesById,
      effectiveSize: prepared.effectiveSize,
      deletionSummary: Object.freeze({
        count: revision.deletionCount,
        freeListHeadBefore: revision.freeListHeadBefore,
        freeListHeadAfter: revision.freeListHeadAfter,
      }),
    });
  } catch (error) {
    if (error?.code === 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED') throw error;
    if (error?.code === 'CLASSIC_INCREMENTAL_LIMIT_EXCEEDED') throw limitExceeded();
    if (error?.code === 'INVALID_CLASSIC_OBJECT_TRANSACTION') throw error;
    throw invalid();
  }
}

export function planClassicObjectDeletionTransaction(request) {
  try {
    const sourceBytes = request && Object.getOwnPropertyDescriptor(request, 'sourceBytes')?.value;
    const sourceStructure = request
      && Object.getOwnPropertyDescriptor(request, 'sourceStructure')?.value;
    const buffer = sourceStructure
      && Object.getOwnPropertyDescriptor(sourceStructure, 'buffer')?.value;
    if (!Buffer.isBuffer(sourceBytes) || buffer !== sourceBytes) throw invalid();
    parseClassicPdfStructure(sourceBytes);
    const generic = planPdfObjectDeletionTransaction(request);
    return Object.freeze({
      ...generic,
      revision: brandClassicDeletionIncrementalRevision(generic.revision),
    });
  } catch (error) {
    if (error?.code === 'CLASSIC_OBJECT_TRANSACTION_LIMIT_EXCEEDED') throw error;
    if (error?.code === 'INVALID_CLASSIC_OBJECT_TRANSACTION') throw error;
    throw invalid();
  }
}
