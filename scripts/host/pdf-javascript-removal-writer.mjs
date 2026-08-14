import { createHash } from 'node:crypto';
import { authorizePdfObjectDeletion, planPdfObjectDeletionTransaction } from './pdf-classic-object-transaction.mjs';
import { buildPdfCompactRewrite, verifyPdfCompactRewrite } from './pdf-compact-rewrite.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { verifyPdfDeletionIncrementalRevision } from './pdf-incremental-deletion-revision.mjs';
import {
  PDF_JAVASCRIPT_REMOVAL_PROFILE, classifyPdfJavaScriptRemovalLocus,
  normalizePdfJavaScriptRemoval, pdfJavaScriptRemovalFailure,
  scanPdfJavaScriptRemovalValue,
} from './pdf-javascript-removal-contract.mjs';

export const MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES = 64 * 1024 * 1024;
const descriptors = new WeakSet(); const states = new WeakMap();
function invalid() { return pdfJavaScriptRemovalFailure(); }
function invalidOutput() { const error = new Error('The compact PDF JavaScript-removal output is invalid.'); error.code = 'INVALID_PDF_JAVASCRIPT_REMOVAL_OUTPUT'; return error; }
function checked(bytes) { if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PDF_JAVASCRIPT_REMOVAL_SOURCE_BYTES || (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)) throw invalid(); return bytes; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameRef(left, right) { return left.object === right.object && left.generation === right.generation; }
function directDictWithout(value, key) { const entries = new Map(value.entries); entries.delete(key); return Object.freeze({ type: 'dict', entries }); }

function sourceProfile(sourceBytes) {
  const structure = parseClassicPdfStructure(checked(sourceBytes));
  const records = new Map();
  for (const entry of structure.effective.values()) {
    if (entry.status !== 'n') continue;
    const object = resolveClassicPdfObject(structure, { type: 'ref', object: entry.object, generation: entry.generation });
    if (object.compressed) throw invalid();
    records.set(`${entry.object}:${entry.generation}`, object);
  }
  const resolve = (reference) => {
    const object = records.get(`${reference.object}:${reference.generation}`);
    if (!object) throw invalid();
    return object;
  };
  const catalog = resolve(structure.root); const locus = classifyPdfJavaScriptRemovalLocus(catalog.value, resolve);
  for (const [identity, object] of records) {
    const isCatalog = identity === `${structure.root.object}:${structure.root.generation}`;
    if (isCatalog) {
      const cleaned = directDictWithout(object.value, locus.kind === 'open-action' ? 'OpenAction' : 'Names');
      scanPdfJavaScriptRemovalValue(cleaned);
    } else if (!locus.deletionReferences.some((reference) => identity === `${reference.object}:${reference.generation}`)) scanPdfJavaScriptRemovalValue(object.value);
  }
  const occurrences = new Map();
  const collect = (value) => {
    if (value?.type === 'ref') occurrences.set(`${value.object}:${value.generation}`, (occurrences.get(`${value.object}:${value.generation}`) ?? 0) + 1);
    else if (value?.type === 'array') for (const entry of value.values) collect(entry);
    else if (value?.type === 'dict') for (const entry of value.entries.values()) collect(entry);
  };
  for (const object of records.values()) collect(object.value);
  const expected = locus.kind === 'open-action' ? new Map([[`${locus.actionReference.object}:${locus.actionReference.generation}`, 1]]) : new Map([
    [`${locus.namesReference.object}:${locus.namesReference.generation}`, 1],
    [`${locus.actionReference.object}:${locus.actionReference.generation}`, 1],
  ]);
  for (const [identity, count] of expected) if (occurrences.get(identity) !== count) throw invalid();
  return Object.freeze({ structure, catalog, locus, records });
}

function changedId(source) {
  return createHash('sha256').update('Platen JavaScript removal ID v1\0', 'utf8')
    .update(createHash('sha256').update(source).digest()).digest().subarray(0, 16);
}

function outputProof(source, output, removed, locus) {
  const sourceStructure = parseClassicPdfStructure(source); const structure = parseClassicPdfStructure(output);
  if (structure.revisions.length !== 1 || structure.revisions[0].trailer.has('Prev') || !sameRef(structure.root, sourceStructure.root)
    || Boolean(structure.info) !== Boolean(sourceStructure.info) || (structure.info && !sameRef(structure.info, sourceStructure.info))
    || Boolean(structure.id) !== Boolean(sourceStructure.id) || (structure.id && (!structure.id[0].equals(sourceStructure.id[0]) || !structure.id[1].equals(changedId(source))))
    || !output.subarray(0, 8).equals(source.subarray(0, 8))) throw invalid();
  for (const entry of structure.effective.values()) if (entry.status === 'n') {
    const object = resolveClassicPdfObject(structure, { type: 'ref', object: entry.object, generation: entry.generation });
    if (object.compressed) throw invalid(); scanPdfJavaScriptRemovalValue(object.value);
    if (object.value?.type === 'dict' && object.value.entries.get('S')?.type === 'name' && object.value.entries.get('S').value === 'JavaScript') throw invalid();
  }
  for (const reference of removed) {
    try { resolveClassicPdfObject(structure, reference); throw invalid(); } catch (error) { if (error?.code === 'INVALID_PDF_JAVASCRIPT_REMOVAL') throw error; }
  }
  return Object.freeze({
    profile: PDF_JAVASCRIPT_REMOVAL_PROFILE,
    sourceBytes: source.length, outputBytes: output.length,
    sourceSha256: hash(source), outputSha256: hash(output),
    removedLocus: locus, removedObjectCount: removed.length,
    closedClassicRevision: true, priorRevisionsAbsent: true,
    javascriptSurfacesAbsent: true, removedReferencesUnresolvable: true,
    rootPreserved: true, infoPreserved: true,
    idPolicy: sourceStructure.id ? 'permanent-preserved-changing-updated' : 'absent',
  });
}

export function verifyPdfJavaScriptRemoval({ sourceBytes, outputBytes, request: requestValue, expectedRemoval } = {}) {
  try {
    const request = normalizePdfJavaScriptRemoval(requestValue);
    if (!descriptors.has(expectedRemoval) || !Buffer.isBuffer(outputBytes)) throw invalid(); const state = states.get(expectedRemoval); const source = checked(sourceBytes);
    if (!state || hash(source) !== state.sourceSha256 || outputBytes.length !== state.outputBytes || hash(outputBytes) !== state.outputSha256) throw invalid();
    const rebuilt = buildPdfJavaScriptRemoval(source, request);
    if (!rebuilt.bytes.equals(outputBytes)) throw invalid();
    return outputProof(source, outputBytes, state.removed, state.locus);
  } catch { throw invalid(); }
}

export function inspectPdfJavaScriptRemoval(sourceBytes, outputBytes, requestValue) {
  try {
    const request = normalizePdfJavaScriptRemoval(requestValue);
    const source = checked(sourceBytes);
    if (!Buffer.isBuffer(outputBytes)
      || (typeof SharedArrayBuffer !== 'undefined'
        && outputBytes.buffer instanceof SharedArrayBuffer)) throw invalid();
    const rebuilt = buildPdfJavaScriptRemoval(source, request);
    if (!rebuilt.bytes.equals(outputBytes)) throw invalid();
    return outputProof(
      source,
      outputBytes,
      sourceProfile(source).locus.deletionReferences,
      rebuilt.proof.removedLocus,
    );
  } catch { throw invalidOutput(); }
}

export function buildPdfJavaScriptRemoval(sourceBytes, requestValue) {
  try {
    normalizePdfJavaScriptRemoval(requestValue);
    const source = checked(sourceBytes); const profile = sourceProfile(source);
    const deletionHandles = profile.locus.deletionReferences.map((reference) => authorizePdfObjectDeletion(profile.structure, reference));
    const catalogValue = directDictWithout(profile.catalog.value, profile.locus.kind === 'open-action' ? 'OpenAction' : 'Names');
    const changingId = profile.structure.id && profile.structure.id[1].length === 16
      ? changedId(source) : profile.structure.id ? invalid() : null;
    const transaction = planPdfObjectDeletionTransaction({ sourceBytes: source, sourceStructure: profile.structure, deletions: deletionHandles, updates: [{ reference: profile.structure.root, value: catalogValue }], additions: [], info: { kind: 'preserve' }, changingId });
    const appended = Buffer.concat([source, transaction.revision.bytes]);
    verifyPdfDeletionIncrementalRevision({ sourceBytes: source, outputBytes: appended, sourceStructure: profile.structure, expectedRevision: transaction.revision });
    const rewrite = buildPdfCompactRewrite(appended); verifyPdfCompactRewrite({ sourceBytes: appended, outputBytes: rewrite.bytes, expectedRewrite: rewrite });
    const proof = outputProof(source, rewrite.bytes, profile.locus.deletionReferences, profile.locus.kind);
    const descriptor = Object.freeze({ bytes: rewrite.bytes, proof }); descriptors.add(descriptor); states.set(descriptor, Object.freeze({ sourceSha256: hash(source), outputSha256: hash(rewrite.bytes), outputBytes: rewrite.bytes.length, removed: profile.locus.deletionReferences, locus: profile.locus.kind }));
    return descriptor;
  } catch { throw invalid(); }
}
