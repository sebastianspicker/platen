import { createHash } from 'node:crypto';
import { pdfDictionary, pdfReference } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { pendingPdfObjectReference, planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { buildPdfCompactRewrite, verifyPdfCompactRewrite } from './pdf-compact-rewrite.mjs';
import { resolvePdfPageTree } from './pdf-page-tree-resolver.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';

export const FULL_PAGE_REDACTION_PROFILE = 'local-object-full-page-redaction-v1';
export const FULL_PAGE_REDACTION_BATCH_PROFILE = 'local-object-full-page-redaction-batch-v1';
const SHA256 = /^[0-9a-f]{64}$/;
const name = (value) => Object.freeze({ type: 'name', value });
const number = (value) => Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw: String(value) });
const dict = (entries) => Object.freeze({ type: 'dict', entries: new Map(entries) });
const array = (values) => Object.freeze({ type: 'array', values: Object.freeze(values) });
const ref = (value) => pdfReference(value);
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported() { return fail('UNSUPPORTED_FULL_PAGE_REDACTION', 'PDF is outside the strict object-level full-page redaction subset.'); }
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || value.profile !== FULL_PAGE_REDACTION_PROFILE || !SHA256.test(value.sourceSha256 ?? '')
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 100) throw fail('INVALID_FULL_PAGE_REDACTION', 'Full-page redaction request is invalid.');
  return Object.freeze({ profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256: value.sourceSha256, page: value.page });
}
function passive(structure) {
  const catalog = pdfDictionary(resolvePdfObject(structure, structure.root).value);
  if (catalog.get('Type')?.value !== 'Catalog' || [...catalog.keys()].some((key) => ['AA', 'AcroForm', 'Metadata', 'Names', 'OpenAction', 'Outlines', 'Perms', 'OCProperties', 'Encrypt'].includes(key))) throw unsupported();
  visitPdfObjects(structure, (object) => {
    const value = object.value; if (value?.type !== 'dict') return;
    const entries = value.entries; const type = entries.get('Type')?.value; const subtype = entries.get('Subtype')?.value;
    if (['Sig', 'Metadata', 'OCG', 'OCMD', 'Action', 'Widget', 'Filespec', 'EmbeddedFile'].includes(type)
    || subtype === 'XML' || entries.has('A') || entries.has('AA') || entries.has('JS') || entries.has('XFA')) throw unsupported();
  });
}
function pageState(sourceBytes, request) {
  const structure = parsePdfStructure(sourceBytes); passive(structure);
  // parsePdfStructure brands even classic-xref PDFs as the generic authority,
  // while the page-tree helper's classic branch intentionally requires the
  // classic authority. Feed it the matching parsed view without changing the
  // generic structure used for transaction and reachability proof.
  const treeStructure = structure.xrefFlavor === 'classic'
    ? parseClassicPdfStructure(sourceBytes)
    : structure;
  const tree = resolvePdfPageTree({ structure: treeStructure, limits: { maxPages: 100 } }); const page = tree.pages[request.page - 1]; if (!page || page.rotate !== 0) throw unsupported();
  if (!page.contents.length || !page.page.value?.entries?.has('Resources')) throw unsupported();
  const rawResources = page.page.value.entries.get('Resources');
  if (!['dict', 'ref'].includes(rawResources?.type)) throw unsupported();
  const superseded = new Set(page.contents.map((entry) => `${entry.reference.object}:${entry.reference.generation}`));
  if (rawResources.type === 'ref') superseded.add(`${rawResources.object}:${rawResources.generation}`);
  const collect = (value) => {
    if (value?.type === 'ref') { superseded.add(`${value.object}:${value.generation}`); return; }
    if (value?.type === 'array') value.values.forEach(collect);
    if (value?.type === 'dict') value.entries.forEach(collect);
  };
  if (rawResources.type === 'dict') collect(rawResources);
  visitPdfObjects(structure, (object) => {
    if (object.reference.object === page.reference.object) return;
    const scan = (value) => {
      if (value?.type === 'ref' && superseded.has(`${value.object}:${value.generation}`)) throw unsupported();
      if (value?.type === 'array') value.values.forEach(scan);
      if (value?.type === 'dict') value.entries.forEach(scan);
    };
    scan(object.value);
  });
  const crop = page.cropBox; if (!crop.every(Number.isFinite) || crop[2] <= crop[0] || crop[3] <= crop[1]) throw unsupported();
  return { structure, tree, page, crop, superseded };
}
function blackStream(crop) { return Buffer.from(`q 0 g ${crop[0]} ${crop[1]} ${crop[2] - crop[0]} ${crop[3] - crop[1]} re f Q\n`, 'latin1'); }
function build(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || createHash('sha256').update(sourceBytes).digest('hex') !== request.sourceSha256) throw unsupported();
  const state = pageState(sourceBytes, request); const stream = blackStream(state.crop); const streamRef = pendingPdfObjectReference('redaction-stream');
  const pageValue = dict([...pdfDictionary(state.page.page.value), ['Resources', dict([])], ['Contents', streamRef]]);
  const tx = planPdfObjectTransaction({ sourceBytes, sourceStructure: state.structure, updates: [{ reference: ref(state.page.reference), value: pageValue }], additions: [{ id: 'redaction-stream', value: dict([['Length', number(stream.length)]]), streamBytes: stream }], info: { kind: 'preserve' }, changingId: null });
  const appended = Buffer.concat([sourceBytes, tx.revision.bytes]); const rewrite = buildPdfCompactRewrite(appended); verifyPdfCompactRewrite({ sourceBytes: appended, outputBytes: rewrite.bytes, expectedRewrite: rewrite });
  const output = parsePdfStructure(rewrite.bytes); for (const key of state.superseded) { const [object, generation] = key.split(':').map(Number); if (output.effective?.has(object) || (() => { try { resolvePdfObject(output, { type: 'ref', object, generation }); return true; } catch { return false; } })()) throw unsupported(); }
  return Object.freeze({ bytes: rewrite.bytes, proof: Object.freeze({ profile: FULL_PAGE_REDACTION_PROFILE, page: request.page, sourceSha256: request.sourceSha256, closedRevision: true, sourcePrefixPreserved: false, priorRevisionsAbsent: true, cropBoxFilled: true, directEmptyResources: true, supersededReferencesAbsent: true, blackStreamObjectNumber: tx.referencesById['redaction-stream'].object, outputSha256: createHash('sha256').update(rewrite.bytes).digest('hex') }) });
}
export function writeFullPageRedaction(sourceBytes, requestValue) { const request = normalize(requestValue); try { return build(sourceBytes, request); } catch (error) { if (error?.code === 'INVALID_FULL_PAGE_REDACTION') throw error; throw unsupported(); } }

function normalizeBatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || value.profile !== FULL_PAGE_REDACTION_BATCH_PROFILE || !SHA256.test(value.sourceSha256 ?? '')
    || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 32
    || value.pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > 100)
    || value.pages.some((page, index) => index > 0 && page <= value.pages[index - 1])) {
    throw fail('INVALID_FULL_PAGE_REDACTION_BATCH', 'Full-page redaction batch request is invalid.');
  }
  return Object.freeze({ profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: value.sourceSha256, pages: Object.freeze([...value.pages]) });
}

function batchState(sourceBytes, request) {
  const structure = parsePdfStructure(sourceBytes); passive(structure);
  const treeStructure = structure.xrefFlavor === 'classic' ? parseClassicPdfStructure(sourceBytes) : structure;
  const tree = resolvePdfPageTree({ structure: treeStructure, limits: { maxPages: 100 } });
  const targets = request.pages.map((pageNumber) => {
    const page = tree.pages[pageNumber - 1]; if (!page || page.rotate !== 0 || !page.contents.length || !page.page.value?.entries?.has('Resources')) throw unsupported();
    const rawResources = page.page.value.entries.get('Resources'); if (!['dict', 'ref'].includes(rawResources?.type)) throw unsupported();
    return { pageNumber, page, rawResources, crop: page.cropBox };
  });
  const targetPages = new Set(targets.map(({ page }) => `${page.reference.object}:${page.reference.generation}`)); const superseded = new Set(); const targetOwners = new Map();
  const collectTargetRefs = (value, pageNumber) => { if (value?.type === 'ref') { const key = `${value.object}:${value.generation}`; if (targetOwners.has(key) && targetOwners.get(key) !== pageNumber) throw unsupported(); targetOwners.set(key, pageNumber); return; } if (value?.type === 'array') value.values.forEach((entry) => collectTargetRefs(entry, pageNumber)); if (value?.type === 'dict') value.entries.forEach((entry) => collectTargetRefs(entry, pageNumber)); };
  const collect = (value) => { if (value?.type === 'ref') { superseded.add(`${value.object}:${value.generation}`); return; } if (value?.type === 'array') value.values.forEach(collect); if (value?.type === 'dict') value.entries.forEach(collect); };
  for (const { page, rawResources, pageNumber } of targets) { page.contents.forEach((entry) => { const key = `${entry.reference.object}:${entry.reference.generation}`; if (targetOwners.has(key) && targetOwners.get(key) !== pageNumber) throw unsupported(); targetOwners.set(key, pageNumber); superseded.add(key); }); collectTargetRefs(rawResources, pageNumber); collect(rawResources); }
  const queue = [...superseded]; const seen = new Set();
  while (queue.length) { const key = queue.pop(); if (seen.has(key)) continue; seen.add(key); const [object, generation] = key.split(':').map(Number); let resolved; try { resolved = resolvePdfObject(structure, { type: 'ref', object, generation }); } catch { throw unsupported(); } const before = superseded.size; collect(resolved.value); if (superseded.size > before) queue.push(...[...superseded].filter((entry) => !seen.has(entry))); }
  visitPdfObjects(structure, (object) => {
    const key = `${object.reference.object}:${object.reference.generation}`; if (targetPages.has(key) || superseded.has(key)) return;
    const scan = (value) => { if (value?.type === 'ref' && superseded.has(`${value.object}:${value.generation}`)) throw unsupported(); if (value?.type === 'array') value.values.forEach(scan); if (value?.type === 'dict') value.entries.forEach(scan); };
    scan(object.value);
  });
  if (targets.some(({ crop }) => !crop.every(Number.isFinite) || crop[2] <= crop[0] || crop[3] <= crop[1])) throw unsupported();
  return { structure, targets, superseded };
}

function buildBatch(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || createHash('sha256').update(sourceBytes).digest('hex') !== request.sourceSha256) throw unsupported();
  const state = batchState(sourceBytes, request); const updates = []; const additions = []; const proofs = [];
  for (const target of state.targets) {
    const id = `redaction-stream-${target.pageNumber}`; const stream = blackStream(target.crop); const streamRef = pendingPdfObjectReference(id);
    const pageValue = dict([...pdfDictionary(target.page.page.value), ['Resources', dict([])], ['Contents', streamRef]]);
    updates.push({ reference: ref(target.page.reference), value: pageValue }); additions.push({ id, value: dict([['Length', number(stream.length)]]), streamBytes: stream });
    proofs.push(Object.freeze({ page: target.pageNumber, cropBox: Object.freeze([...target.crop]), cropBoxFilled: true, directEmptyResources: true, blackStreamObjectNumber: null }));
  }
  const tx = planPdfObjectTransaction({ sourceBytes, sourceStructure: state.structure, updates, additions, info: { kind: 'preserve' }, changingId: null });
  const appended = Buffer.concat([sourceBytes, tx.revision.bytes]); const rewrite = buildPdfCompactRewrite(appended); verifyPdfCompactRewrite({ sourceBytes: appended, outputBytes: rewrite.bytes, expectedRewrite: rewrite });
  const output = parsePdfStructure(rewrite.bytes); for (const key of state.superseded) { const [object] = key.split(':').map(Number); if (output.effective?.has(object)) throw unsupported(); }
  const outputTreeStructure = output.xrefFlavor === 'classic' ? parseClassicPdfStructure(rewrite.bytes) : output;
  const outputTree = resolvePdfPageTree({ structure: outputTreeStructure, limits: { maxPages: 100 } });
  for (const proof of proofs) { const page = outputTree.pages[proof.page - 1]; if (!page || page.rotate !== 0 || page.cropBox.some((value, index) => value !== proof.cropBox[index]) || page.page.value.entries.get('Resources')?.type !== 'dict' || page.page.value.entries.get('Resources').entries.size !== 0 || page.contents.length !== 1) throw unsupported(); const stream = page.contents[0].stream; const bytes = rewrite.bytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength); if (!bytes.equals(blackStream(proof.cropBox))) throw unsupported(); }
  const outputSha256 = createHash('sha256').update(rewrite.bytes).digest('hex');
  return Object.freeze({ bytes: rewrite.bytes, proof: Object.freeze({ profile: FULL_PAGE_REDACTION_BATCH_PROFILE, pages: request.pages, sourceSha256: request.sourceSha256, closedRevision: true, sourcePrefixPreserved: false, priorRevisionsAbsent: true, targets: Object.freeze(proofs.map((proof) => Object.freeze({ ...proof, blackStreamObjectNumber: tx.referencesById[`redaction-stream-${proof.page}`].object }))), supersededReferences: Object.freeze([...state.superseded].sort()), supersededReferencesAbsent: true, outputSha256 }) });
}

export function writeFullPageRedactionBatch(sourceBytes, requestValue) { const request = normalizeBatch(requestValue); try { return buildBatch(sourceBytes, request); } catch (error) { if (error?.code === 'INVALID_FULL_PAGE_REDACTION_BATCH') throw error; throw unsupported(); } }
