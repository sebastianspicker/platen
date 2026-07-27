import { createHash } from 'node:crypto';
import { pdfReference } from './pdf-classic-syntax.mjs';
import { parsePdfStructure } from './pdf-classic-structure.mjs';
import { pdfStructureAuthority } from './pdf-structure-authority.mjs';

const MAX_VISITS = 100_000;
const handles = new WeakMap();
const admissions = new WeakMap();
const authorizationSources = new WeakMap();

function invalid() { const error = new Error('The incremental PDF deletion request is invalid.'); error.code = 'INVALID_INCREMENTAL_PDF_DELETION'; return error; }
function sourceIdentity(structure) {
  const buffer = Object.getOwnPropertyDescriptor(structure ?? {}, 'buffer')?.value;
  if (!Buffer.isBuffer(buffer)
    || (typeof SharedArrayBuffer !== 'undefined'
      && buffer.buffer instanceof SharedArrayBuffer)) throw invalid();
  return Object.freeze({
    sourceLength: buffer.length,
    sourceSha256: createHash('sha256').update(buffer).digest('hex'),
  });
}
function sameIdentity(left, right) {
  return left.sourceLength === right.sourceLength
    && left.sourceSha256 === right.sourceSha256;
}
function authorizationSource(structure) {
  let source = authorizationSources.get(structure);
  if (!source) {
    const identity = sourceIdentity(structure);
    const buffer = Object.getOwnPropertyDescriptor(structure ?? {}, 'buffer')?.value;
    source = Object.freeze({
      ...identity,
      parsed: parsePdfStructure(buffer),
    });
    authorizationSources.set(structure, source);
  }
  return source;
}
function references(value, result, state) {
  if (++state.visits > MAX_VISITS) throw invalid();
  if (value?.type === 'ref') { result.push(value); return; }
  if (value?.type === 'array') for (const entry of value.values) references(entry, result, state);
  else if (value?.type === 'dict') for (const entry of value.entries.values()) references(entry, result, state);
}
function signature(value, state) {
  if (++state.visits > MAX_VISITS) throw invalid();
  if (value?.type === 'array') return value.values.some((entry) => signature(entry, state));
  if (value?.type !== 'dict') return false;
  const type = value.entries.get('Type'); const field = value.entries.get('FT');
  return value.entries.has('ByteRange') || type?.type === 'name' && type.value === 'Sig'
    || field?.type === 'name' && field.value === 'Sig' || [...value.entries.values()].some((entry) => signature(entry, state));
}
function trusted(structure) {
  const authority = pdfStructureAuthority(structure, 'generic')
    ?? pdfStructureAuthority(structure, 'classic');
  if (!(authority?.effective instanceof Map) || !(authority.objects instanceof Map)
    || (authority.compressedObjects !== undefined
      && !(authority.compressedObjects instanceof Map))) throw invalid();
  return authority;
}
function trustedObject(authority, entry) {
  const object = entry.status === 'c'
    ? authority.compressedObjects?.get(entry)
    : authority.objects.get(`${entry.object}:${entry.generation}:${entry.offset}`);
  if (!object) throw invalid();
  return object;
}

export function validatePdfDeletionFreeList(structure) {
  const effective = trusted(structure).effective; const size = structure?.finalSize;
  if (!(effective instanceof Map) || !Number.isSafeInteger(size) || size < 1 || effective.size !== size) throw invalid();
  const zero = effective.get(0); if (!zero || zero.status !== 'f' || zero.generation !== 65_535) throw invalid();
  const seen = new Set(); let next = zero.offset;
  while (next !== 0) { if (!Number.isSafeInteger(next) || next < 1 || next >= size || seen.has(next)) throw invalid(); const entry = effective.get(next); if (!entry || entry.status !== 'f') throw invalid(); seen.add(next); next = entry.offset; }
  for (let number = 1; number < size; number += 1) { const entry = effective.get(number); if (!entry || (entry.status === 'f' && entry.generation === 65_535 && !seen.has(number) && entry.offset !== 0) || (entry.status === 'f' && entry.generation < 65_535 && !seen.has(number))) throw invalid(); }
  return Object.freeze({ head: zero.offset, freeCount: seen.size });
}

export function authorizePdfObjectDeletion(structure, reference) {
  try {
    const normalized = pdfReference(reference); const source = authorizationSource(structure);
    const freeList = validatePdfDeletionFreeList(source.parsed);
    const authority = trusted(source.parsed);
    const entry = authority.effective.get(normalized.object);
    if (!entry || entry.status !== 'n' || entry.generation !== normalized.generation || normalized.object < 1 || normalized.generation > 65_534 || authority.controlObjectNumbers?.has(normalized.object) || (source.parsed.root.object === normalized.object && source.parsed.root.generation === normalized.generation) || (source.parsed.info?.object === normalized.object && source.parsed.info?.generation === normalized.generation)) throw invalid();
    trustedObject(authority, entry);
    const handle = Object.freeze({}); handles.set(handle, Object.freeze({ structure, reference: Object.freeze({ type: 'ref', object: normalized.object, generation: normalized.generation }), freeList, sourceLength: source.sourceLength, sourceSha256: source.sourceSha256 })); return handle;
  } catch (error) { if (error?.code === 'INVALID_INCREMENTAL_PDF_DELETION') throw error; throw invalid(); }
}

export function authorizedPdfDeletion(handle, structure) { const record = handles.get(handle); if (!record || record.structure !== structure || !sameIdentity(record, sourceIdentity(structure))) throw invalid(); return record; }
export function admitPdfDeletions(structure, deletionHandles) {
  try {
    if (!Array.isArray(deletionHandles) || deletionHandles.length < 1 || deletionHandles.length > 10_000) throw invalid();
    const identity = sourceIdentity(structure);
    const records = deletionHandles.map((handle) => { const record = handles.get(handle); if (!record || record.structure !== structure || !sameIdentity(record, identity)) throw invalid(); return record; }); const seen = new Set();
    for (const record of records) { if (seen.has(record.reference.object)) throw invalid(); seen.add(record.reference.object); }
    const authorization = authorizationSources.get(structure);
    if (!authorization || !sameIdentity(authorization, identity)) throw invalid();
    const admission = Object.freeze({ structure, targets: Object.freeze(records.map(({ reference }) => reference).sort((a, b) => a.object - b.object)), freeList: validatePdfDeletionFreeList(authorization.parsed), ...identity }); admissions.set(admission, admission); return admission;
  } catch (error) { if (error?.code === 'INVALID_INCREMENTAL_PDF_DELETION') throw error; throw invalid(); }
}
export function admittedPdfDeletions(admission, structure) { const record = admissions.get(admission); if (!record || record.structure !== structure || !sameIdentity(record, sourceIdentity(structure))) throw invalid(); return record; }
export function validatePdfDeletionReferences(structure, deleted, replacements = []) {
  try {
    const numbers = new Set(deleted.map(({ object }) => object)); const state = { visits: 0 }; const authority = trusted(structure); const replacementMap = new Map(replacements.map((record) => [record.reference.object, record]));
    for (const object of [...authority.objects.values(), ...(authority.compressedObjects?.values() ?? [])]) if (signature(object.value, state)) throw invalid();
    for (const [number, entry] of authority.effective) if (!numbers.has(number) && (entry.status === 'n' || entry.status === 'c')) { const replacement = replacementMap.get(number); const refs = []; references(replacement?.value ?? trustedObject(authority, entry).value, refs, state); if (refs.some((reference) => numbers.has(reference.object))) throw invalid(); }
    for (const record of replacementMap.values()) { if (signature(record.value, state)) throw invalid(); if (record.reference.object >= structure.finalSize) { const refs = []; references(record.value, refs, state); if (refs.some((reference) => numbers.has(reference.object))) throw invalid(); } }
  } catch (error) { if (error?.code === 'INVALID_INCREMENTAL_PDF_DELETION') throw error; throw invalid(); }
}
