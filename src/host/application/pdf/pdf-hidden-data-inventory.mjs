import { createHash } from 'node:crypto';

import { parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { pdfDictionary } from './pdf-classic-syntax.mjs';

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const OPTION_KEYS = Object.freeze(new Set(['sourceSha256']));
const ACTION_TYPES = Object.freeze(new Set([
  'JavaScript', 'Launch', 'SubmitForm', 'ResetForm',
  'ImportData', 'GoTo', 'GoToR', 'URI', 'GoToE',
  'Thread', 'Named', 'Movie', 'Sound', 'SetOCGState',
]));
const ACTION_HIDE_BITS = Object.freeze([1, 2, 32]);

function failure(message) {
  const error = new Error(message);
  error.code = 'INVALID_PDF_HIDDEN_DATA_INVENTORY';
  return error;
}

function checksum(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateOptions(value = {}) {
  if (!isPlainObject(value)) throw failure('Hidden-data inventory request must be an object.');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1) throw failure('Hidden-data inventory request contains unsupported fields.');
  const sourceSha256 = keys[0] === 'sourceSha256' ? value.sourceSha256 : undefined;
  if (keys.length === 1) {
    if (typeof keys[0] !== 'string' || !OPTION_KEYS.has(keys[0])) {
      throw failure('Hidden-data inventory request contains unsupported fields.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'sourceSha256');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined
      || descriptor.set !== undefined || descriptor.enumerable !== true) {
      throw failure('Hidden-data request has invalid option descriptors.');
    }
  }
  if (sourceSha256 !== undefined && (typeof sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sourceSha256))) {
    throw failure('Hidden-data request has an invalid sourceSha256.');
  }
  return Object.freeze({ sourceSha256 });
}

function checkedBuffer(value) {
  if (!Buffer.isBuffer(value) || (typeof SharedArrayBuffer !== 'undefined'
    && value.buffer instanceof SharedArrayBuffer)) throw failure('The source bytes are not supported.');
  if (value.length > MAX_SOURCE_BYTES) throw failure('The source is larger than the supported limit.');
  return value;
}

function checkedStructure(bytes, sourceSha256) {
  if (sourceSha256 && checksum(bytes) !== sourceSha256) throw failure('The provided sourceSha256 does not match the source bytes.');
  try {
    const structure = parsePdfStructure(bytes);
    for (const revision of structure.revisions) {
      if (revision.trailer.has('Encrypt')) throw failure('The PDF source is encrypted and cannot be inspected for hidden data.');
    }
    for (const [, entry] of structure.effective) {
      if (entry.status === 'c') throw failure('Compressed object entries are not supported by this inventory operation.');
    }
    return structure;
  } catch {
    throw failure('The PDF source cannot be parsed for hidden-data inventory.');
  }
}

function key(reference) { return `${reference.object}:${reference.generation}`; }

function numberValue(value) {
  if (value?.type === 'number' && value.integer && Number.isSafeInteger(value.value)) return value.value;
  return null;
}

function nameValue(value) {
  if (value?.type === 'name') return value.value;
  return null;
}

function visitReference(reference, queue) {
  if (!Number.isSafeInteger(reference?.object) || !Number.isSafeInteger(reference?.generation)) return;
  queue.push(reference);
}

function enqueueReferences(value, queue) {
  if (value?.type === 'ref') return void visitReference(value, queue);
  if (value?.type === 'array') return value.values.forEach((entry) => enqueueReferences(entry, queue));
  if (value?.type === 'dict') return value.entries.forEach((entry) => enqueueReferences(entry, queue));
}

function initializeCounts() {
  return {
    trailerInfo: 0,
    xmpMetadata: 0,
    embeddedFiles: 0,
    actions: 0,
    javascriptActions: 0,
    actionObjects: 0,
    acroForm: 0,
    xfa: 0,
    signatureFields: 0,
    byteRanges: 0,
    optionalContent: 0,
    structTree: 0,
    marked: 0,
    hiddenAnnotations: 0,
    pageThumbnails: 0,
    pieceInfo: 0,
    spiderInfo: 0,
    privateData: 0,
    alternateImages: 0,
    opi: 0,
  };
}

function analyzeDictionary(reference, structureInfo, dictionary, counts) {
  const has = (candidate) => dictionary.has(candidate);
  const type = nameValue(dictionary.get('Type'));
  const subtype = nameValue(dictionary.get('Subtype'));
  const annotationFlags = numberValue(dictionary.get('F'));
  const actionType = nameValue(dictionary.get('S'));
  const fieldType = nameValue(dictionary.get('FT'));
  const hasExplicitActionLoci = has('OpenAction') || has('AA') || has('A') || has('JS') || has('Next');
  const isKnownActionType = ACTION_TYPES.has(actionType);

  if (structureInfo && reference.object === structureInfo.object
    && reference.generation === structureInfo.generation) {
    counts.trailerInfo += 1;
  }

  if (has('Metadata') || type === 'Metadata') {
    counts.xmpMetadata += 1;
  }
  if (has('EmbeddedFiles') || has('AF') || type === 'Filespec' || type === 'EmbeddedFile') {
    counts.embeddedFiles += 1;
  }
  if (type === 'Action' || isKnownActionType || hasExplicitActionLoci) {
    counts.actions += 1;
  }
  if (actionType === 'JavaScript' || has('JS')) {
    counts.javascriptActions += 1;
  }
  if (type === 'Action' || isKnownActionType) {
    counts.actionObjects += 1;
  }
  if (has('AcroForm') || type === 'AcroForm') {
    counts.acroForm += 1;
  }
  if (has('XFA') || type === 'XFA') {
    counts.xfa += 1;
  }
  if (fieldType === 'Sig') {
    counts.signatureFields += 1;
  }
  if (has('ByteRange')) {
    counts.byteRanges += 1;
  }
  if (has('OCProperties') || has('OCGs') || has('OCMD')
    || type === 'OCG' || type === 'OCMD') {
    counts.optionalContent += 1;
  }
  if (has('StructTreeRoot') || has('StructElem') || type === 'StructTreeRoot' || type === 'StructElem') {
    counts.structTree += 1;
  }
  if (has('MarkInfo') || type === 'MarkInfo') {
    counts.marked += 1;
  }
  if (type === 'Page' && has('Thumb')) {
    counts.pageThumbnails += 1;
  }
  if (has('PieceInfo')) {
    counts.pieceInfo += 1;
  }
  if (has('SpiderInfo')) {
    counts.spiderInfo += 1;
  }
  if (has('Private')) {
    counts.privateData += 1;
  }
  if (type === 'XObject' && subtype === 'Image' && has('Alternates')) {
    counts.alternateImages += 1;
  }
  if (type === 'XObject' && subtype === 'Image' && has('OPI')) {
    counts.opi += 1;
  }
  if (type === 'Annot' && annotationFlags !== null && ACTION_HIDE_BITS.some((bit) => (annotationFlags & bit) === bit)) {
    counts.hiddenAnnotations += 1;
  }
}

function collectReachableObjectKeys(structure) {
  const queue = [Object.freeze({ type: 'ref', ...structure.root })];
  if (structure.info) queue.push(Object.freeze({ type: 'ref', ...structure.info }));
  const seen = new Set();

  while (queue.length) {
    const reference = queue.pop();
    const objectKey = key(reference);
    if (seen.has(objectKey)) continue;
    const entry = structure.effective.get(reference.object);
    if (!entry || entry.status !== 'n' || entry.generation !== reference.generation) {
      throw failure('Referenced object does not exist.');
    }
    seen.add(objectKey);
    const object = resolvePdfObject(structure, reference);
    if (object.value?.type === 'dict') {
      const dictionary = pdfDictionary(object.value);
      for (const value of dictionary.values()) enqueueReferences(value, queue);
    }
  }
  return seen;
}

function scanObjects(structure, counts) {
  for (const [object, entry] of structure.effective) {
    if (entry.status !== 'n' || object === 0) continue;
    const reference = Object.freeze({ type: 'ref', object, generation: entry.generation });
    const resolved = resolvePdfObject(structure, reference);
    if (resolved.value?.type !== 'dict') continue;
    const dictionary = pdfDictionary(resolved.value);
    analyzeDictionary(reference, structure.info, dictionary, counts);
  }
}

function analyzeStructure(structure) {
  const counts = initializeCounts();
  const effectiveEntries = [...structure.effective.values()].filter((entry) => entry.status === 'n' && entry.object !== 0);
  const latestRevisionObjects = Object.freeze(new Set(
    structure.revisions[0].entries.filter((entry) => entry.status === 'n').map((entry) => entry.object),
  ));
  const reachableObjectKeys = collectReachableObjectKeys(structure);
  const reachableObjectCount = reachableObjectKeys.size;
  const effectiveObjectCount = effectiveEntries.length;
  const unreachableObjectCount = Math.max(0, effectiveObjectCount - reachableObjectCount);
  const priorRevisionResidueObjects = new Set();

  for (let revisionIndex = 1; revisionIndex < structure.revisions.length; revisionIndex += 1) {
    for (const entry of structure.revisions[revisionIndex].entries) {
      if (entry.status === 'n' && !latestRevisionObjects.has(entry.object)
        && entry.object !== 0) {
        priorRevisionResidueObjects.add(entry.object);
      }
    }
  }

  scanObjects(structure, counts);

  return Object.freeze({
    ...counts,
    schema: 'pdf-hidden-data-inventory-v1',
    version: 1,
    revisionCount: structure.revisions.length,
    xrefFlavor: structure.xrefFlavor,
    effectiveObjectCount,
    reachableObjectCount,
    unreachableObjectCount,
    priorRevisionResidue: Object.freeze({
      present: priorRevisionResidueObjects.size > 0,
      objectCount: priorRevisionResidueObjects.size,
    }),
    orphanResidue: Object.freeze({
      present: unreachableObjectCount > 0,
      objectCount: unreachableObjectCount,
    }),
  });
}

export function inspectPdfHiddenDataInventory(sourceBytes, options) {
  const request = validateOptions(options);
  const source = checkedBuffer(sourceBytes);
  const structure = checkedStructure(source, request.sourceSha256);
  const result = analyzeStructure(structure);
  return Object.freeze({
    sourceBytes: source.length,
    sourceSha256: checksum(source),
    ...result,
  });
}
