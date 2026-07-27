import { createHash } from 'node:crypto';
import { authorizePdfObjectDeletion, planPdfObjectDeletionTransaction } from './pdf-classic-object-transaction.mjs';
import { buildPdfCompactRewrite, verifyPdfCompactRewrite } from './pdf-compact-rewrite.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { verifyPdfDeletionIncrementalRevision } from './pdf-incremental-deletion-revision.mjs';
import { PDF_ATTACHMENT_REMOVAL_PROFILE, normalizePdfAttachmentRemoval, pdfAttachmentRemovalFailure, pdfAttachmentRemovalOutputFailure } from './pdf-attachment-removal-contract.mjs';

export const MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const descriptors = new WeakSet(); const states = new WeakMap();
const FORBIDDEN = new Set(['AF', 'AcroForm', 'AA', 'A', 'JS', 'OpenAction', 'Collection', 'Metadata', 'Perms', 'URI', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Trans', 'Dur', 'PresSteps', 'Outlines', 'Next', 'EF', 'EmbeddedFiles', 'Filespec']);
const FORBIDDEN_ANNOTATION_SUBTYPES = new Set([
  'FileAttachment', 'Sound', 'Movie', 'Screen', 'RichMedia', '3D',
]);
function invalid() { return pdfAttachmentRemovalFailure(); }
function invalidOutput() { return pdfAttachmentRemovalOutputFailure(); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function key(reference) { return `${reference.object}:${reference.generation}`; }
function same(left, right) { return left.object === right.object && left.generation === right.generation; }
function checked(bytes) { if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES || (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)) throw invalid(); return bytes; }
function dictWithout(value, ...names) { const entries = new Map(value.entries); names.forEach((name) => entries.delete(name)); return Object.freeze({ type: 'dict', entries }); }
function references(value, output = []) { if (value?.type === 'ref') output.push(value); else if (value?.type === 'array') value.values.forEach((entry) => references(entry, output)); else if (value?.type === 'dict') value.entries.forEach((entry) => references(entry, output)); return output; }

function scan(value, { attachment = false } = {}) {
  if (value?.type === 'array') { value.values.forEach((entry) => scan(entry, { attachment })); return; }
  if (value?.type !== 'dict') return;
  const type = value.entries.get('Type');
  const subtype = value.entries.get('Subtype');
  if (value.entries.has('S') || type?.type === 'name' && ['Action', 'Sig', 'Metadata', 'Filespec', 'EmbeddedFile', 'XRef', 'ObjStm'].includes(type.value)
    || subtype?.type === 'name' && FORBIDDEN_ANNOTATION_SUBTYPES.has(subtype.value)
    || [...FORBIDDEN].some((name) => value.entries.has(name))) {
    if (!attachment) throw invalid();
  }
  value.entries.forEach((entry) => scan(entry, { attachment }));
}

function sourceProfile(sourceBytes) {
  const structure = parseClassicPdfStructure(checked(sourceBytes)); const objects = new Map();
  for (const entry of structure.effective.values()) if (entry.status === 'n') {
    const object = resolveClassicPdfObject(structure, { type: 'ref', object: entry.object, generation: entry.generation });
    objects.set(key(object.reference), object);
  }
  const resolve = (reference) => { const object = objects.get(key(reference)); if (!object) throw invalid(); return object; };
  const catalog = resolve(structure.root);
  if (catalog.stream || catalog.value?.type !== 'dict' || catalog.value.entries.get('Type')?.value !== 'Catalog') throw invalid();
  const names = catalog.value.entries.get('Names');
  if (names?.type !== 'dict' || names.entries.size !== 1 || names.entries.get('EmbeddedFiles')?.type !== 'ref') throw invalid();
  const pageMode = catalog.value.entries.get('PageMode');
  if (pageMode && (pageMode.type !== 'name' || pageMode.value !== 'UseAttachments')) throw invalid();
  for (const name of catalog.value.entries.keys()) if (!['Type', 'Pages', 'Names', 'PageMode'].includes(name)) throw invalid();
  const treeReference = names.entries.get('EmbeddedFiles'); const tree = resolve(treeReference);
  if (tree.stream || tree.value?.type !== 'dict' || tree.value.entries.size !== 1) throw invalid();
  const pair = tree.value.entries.get('Names');
  if (pair?.type !== 'array' || pair.values.length !== 2 || pair.values[0]?.type !== 'string' || pair.values[0].bytes.length < 1 || pair.values[0].bytes.length > 240 || pair.values[1]?.type !== 'ref') throw invalid();
  if ([...pair.values[0].bytes].some((byte) => byte < 0x20 || byte > 0x7e)) throw invalid();
  const fileReference = pair.values[1]; const file = resolve(fileReference);
  if (file.stream || file.value?.type !== 'dict' || file.value.entries.get('Type')?.value !== 'Filespec') throw invalid();
  const allowedFile = new Set(['Type', 'F', 'UF', 'EF']); if ([...file.value.entries.keys()].some((name) => !allowedFile.has(name)) || file.value.entries.get('F')?.type !== 'string' || !file.value.entries.get('F').bytes.equals(pair.values[0].bytes)) throw invalid();
  if (file.value.entries.get('UF') && (file.value.entries.get('UF').type !== 'string' || !file.value.entries.get('UF').bytes.equals(file.value.entries.get('F').bytes))) throw invalid();
  const ef = file.value.entries.get('EF'); if (ef?.type !== 'dict' || ef.entries.size !== 1 || ef.entries.get('F')?.type !== 'ref') throw invalid();
  const embeddedReference = ef.entries.get('F'); const embedded = resolve(embeddedReference); const length = embedded.value?.entries?.get('Length');
  if (!embedded.stream || embedded.value?.type !== 'dict' || embedded.value.entries.size !== 2 || embedded.value.entries.get('Type')?.value !== 'EmbeddedFile' || length?.type !== 'number' || !length.integer || length.value < 1 || length.value > MAX_ATTACHMENT_BYTES || length.value !== embedded.streamLength || embedded.value.entries.has('Filter')) throw invalid();
  if (new Set([key(treeReference), key(fileReference), key(embeddedReference)]).size !== 3) throw invalid();
  for (const [identity, object] of objects) {
    const target = [key(treeReference), key(fileReference), key(embeddedReference)].includes(identity);
    if (!target) scan(identity === key(structure.root) ? dictWithout(object.value, 'Names', 'PageMode') : object.value);
  }
  const counts = new Map(); for (const object of objects.values()) for (const reference of references(object.value)) counts.set(key(reference), (counts.get(key(reference)) ?? 0) + 1);
  const expected = new Map([[key(treeReference), 1], [key(fileReference), 1], [key(embeddedReference), 1]]);
  for (const [identity, count] of expected) if (counts.get(identity) !== count) throw invalid();
  const content = sourceBytes.subarray(embedded.streamStart, embedded.streamStart + embedded.streamLength);
  return Object.freeze({ structure, catalog, treeReference, fileReference, embeddedReference, name: pair.values[0].bytes, content });
}

function outputProof(source, output, profile) {
  const sourceStructure = parseClassicPdfStructure(source); const structure = parseClassicPdfStructure(output);
  const changedId = createHash('sha256').update('Platen attachment removal ID v1\0').update(source).digest().subarray(0, 16);
  if (structure.revisions.length !== 1 || structure.revisions[0].trailer.has('Prev') || !same(structure.root, sourceStructure.root)
    || Boolean(structure.info) !== Boolean(sourceStructure.info) || structure.info && !same(structure.info, sourceStructure.info)
    || Boolean(structure.id) !== Boolean(sourceStructure.id) || structure.id && (!structure.id[0].equals(sourceStructure.id[0]) || !structure.id[1].equals(changedId))) throw invalid();
  for (const entry of structure.effective.values()) if (entry.status === 'n') {
    const object = resolveClassicPdfObject(structure, { type: 'ref', object: entry.object, generation: entry.generation }); scan(object.value);
  }
  for (const reference of [profile.treeReference, profile.fileReference, profile.embeddedReference]) {
    try { resolveClassicPdfObject(structure, reference); throw invalid(); } catch (cause) { if (cause?.code === 'INVALID_PDF_ATTACHMENT_REMOVAL') throw cause; }
  }
  return Object.freeze({ profile: PDF_ATTACHMENT_REMOVAL_PROFILE, sourceBytes: source.length, outputBytes: output.length, sourceSha256: sha(source), outputSha256: sha(output), nameSha256: sha(profile.name), contentSha256: sha(profile.content), contentBytes: profile.content.length, removedObjectCount: 3, closedClassicRevision: true, priorRevisionsAbsent: true, attachmentSurfacesAbsent: true, removedReferencesUnresolvable: true, rootPreserved: true, infoPreserved: true, idPolicy: sourceStructure.id ? 'permanent-preserved-changing-updated' : 'absent' });
}

export function writePdfAttachmentRemoval(sourceBytes, requestValue) {
  try {
    normalizePdfAttachmentRemoval(requestValue); const source = checked(sourceBytes); const profile = sourceProfile(source);
    const deletions = [profile.treeReference, profile.fileReference, profile.embeddedReference].map((reference) => authorizePdfObjectDeletion(profile.structure, reference));
    const transaction = planPdfObjectDeletionTransaction({ sourceBytes: source, sourceStructure: profile.structure, deletions, updates: [{ reference: profile.structure.root, value: dictWithout(profile.catalog.value, 'Names', 'PageMode') }], additions: [], info: { kind: 'preserve' }, changingId: profile.structure.id ? createHash('sha256').update('Platen attachment removal ID v1\0').update(source).digest().subarray(0, 16) : null });
    const appended = Buffer.concat([source, transaction.revision.bytes]); verifyPdfDeletionIncrementalRevision({ sourceBytes: source, outputBytes: appended, sourceStructure: profile.structure, expectedRevision: transaction.revision });
    const rewrite = buildPdfCompactRewrite(appended); verifyPdfCompactRewrite({ sourceBytes: appended, outputBytes: rewrite.bytes, expectedRewrite: rewrite });
    const proof = outputProof(source, rewrite.bytes, profile); const descriptor = Object.freeze({ bytes: rewrite.bytes, proof }); descriptors.add(descriptor); states.set(descriptor, Object.freeze({ sourceSha256: sha(source), outputSha256: sha(rewrite.bytes), profile })); return descriptor;
  } catch { throw invalid(); }
}

export function inspectPdfAttachmentRemoval(sourceBytes, outputBytes, requestValue, expectedRemoval) {
  try { normalizePdfAttachmentRemoval(requestValue); const state = states.get(expectedRemoval); const source = checked(sourceBytes); if (!descriptors.has(expectedRemoval) || !state || !Buffer.isBuffer(outputBytes) || sha(source) !== state.sourceSha256 || sha(outputBytes) !== state.outputSha256) throw invalid(); const rebuilt = writePdfAttachmentRemoval(source, requestValue); if (!rebuilt.bytes.equals(outputBytes)) throw invalid(); return outputProof(source, outputBytes, state.profile); } catch { throw invalidOutput(); }
}
