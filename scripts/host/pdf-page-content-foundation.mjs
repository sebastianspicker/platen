import { createHash } from 'node:crypto';

import { pdfDictionary, pdfReference } from './pdf-classic-syntax.mjs';
import {
  parsePdfStructure,
  parseClassicPdfStructure,
  resolvePdfObject,
} from './pdf-classic-structure.mjs';
import { pendingPdfObjectReference, planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { tokenizePdfContentStream, PDF_CONTENT_STREAM_LIMITS } from './pdf-content-stream-tokenizer.mjs';
import { resolvePdfPageTree } from './pdf-page-tree-resolver.mjs';

export const PDF_PAGE_CONTENT_FOUNDATION_PROFILE = 'local-page-content-foundation-v1';
export const PDF_PAGE_CONTENT_FOUNDATION_LIMITS = Object.freeze({
  maxSourceBytes: 256 * 1024 * 1024,
  maxAppendBytes: 64 * 1024,
  maxEdits: 64,
  maxPages: 10_000,
  tokenizerLimits: Object.freeze(PDF_CONTENT_STREAM_LIMITS),
});

const OPERATOR_ARITIES = Object.freeze(new Map([
  ['q', 0], ['Q', 0], ['cm', 6], ['w', 1], ['J', 1], ['j', 1], ['M', 1],
  ['m', 2], ['l', 2], ['c', 6], ['v', 4], ['y', 4], ['h', 0], ['re', 4],
  ['S', 0], ['s', 0], ['f', 0], ['F', 0], ['f*', 0], ['B', 0], ['B*', 0],
  ['b', 0], ['b*', 0], ['n', 0], ['G', 1], ['g', 1], ['RG', 3], ['rg', 3],
  ['K', 4], ['k', 4],
]));

function invalid(message = 'Page-content foundation request is malformed.') {
  const error = new Error(message);
  error.code = 'INVALID_PAGE_CONTENT_FOUNDATION';
  return error;
}
function unsupported(message = 'The PDF is outside the supported bounded page-content foundation subset.') {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_PAGE_CONTENT_FOUNDATION';
  return error;
}
function invalidOutput(message = 'Page-content foundation output proof failed.') {
  const error = new Error(message);
  error.code = 'INVALID_PAGE_CONTENT_FOUNDATION_OUTPUT';
  return error;
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameReference(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function referenceText(reference) { return `${reference.object} ${reference.generation} R`; }
function exactObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.size || keys.some((key) => {
    if (typeof key !== 'string' || !allowed.has(key)) return true;
    const descriptor = descriptors[key];
    return !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true;
  }) || required.some((key) => !Object.hasOwn(descriptors, key))) throw invalid();
  return Object.fromEntries(required.concat(optional).map((key) => [key, descriptors[key]?.value]));
}
function arrayValues(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Number.isSafeInteger(descriptors.length?.value)
    || Object.keys(descriptors).length !== descriptors.length.value + 1) throw invalid();
  return Array.from({ length: descriptors.length.value }, (_, index) => {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid();
    return descriptor.value;
  });
}
function numberValue(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}
function numberPdf(value) {
  if (!Number.isSafeInteger(value)) throw invalid();
  return Object.freeze({ type: 'number', value, integer: true, raw: String(value) });
}
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: Object.freeze(new Map(entries)) }); }
function normalizeLimits(value) {
  if (value === undefined) return PDF_PAGE_CONTENT_FOUNDATION_LIMITS.tokenizerLimits;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const keys = Object.keys(value);
  if (keys.some((key) => !(key in PDF_CONTENT_STREAM_LIMITS))) throw invalid();
  const normalized = { ...PDF_CONTENT_STREAM_LIMITS, ...value };
  for (const key of Object.keys(PDF_CONTENT_STREAM_LIMITS)) {
    if (!Number.isSafeInteger(normalized[key]) || normalized[key] < 1
      || normalized[key] > PDF_CONTENT_STREAM_LIMITS[key]) throw invalid();
  }
  return Object.freeze(normalized);
}

function changedId(sourceBytes, request) {
  const hash = createHash('sha256').update('Platen page-content foundation ID v1\0', 'utf8');
  hash.update(createHash('sha256').update(sourceBytes).digest());
  for (const edit of request.edits) {
    hash.update(`${edit.page}:${edit.position}:${edit.content.length}:`, 'utf8');
    hash.update(edit.content);
  }
  return hash.digest().subarray(0, 16);
}

function validateInsertedContent(content, limits) {
  if (content.length < 1 || content.length > PDF_PAGE_CONTENT_FOUNDATION_LIMITS.maxAppendBytes) throw invalid();
  let tokenized;
  try {
    tokenized = tokenizePdfContentStream({
      stream: { stream: true, streamStart: 0, streamLength: content.length,
        value: dict([['Length', numberPdf(content.length)]]) },
      encodedBytes: content,
      limits,
    });
  } catch { throw invalid('Inserted content is not a supported passive PDF content stream.'); }
  const operands = [];
  let graphicsDepth = 0;
  const operatorCounts = new Map();
  for (const token of tokenized.tokens) {
    if (token.type === 'number') {
      if (!Number.isFinite(token.value)) throw invalid();
      operands.push(token.value);
      continue;
    }
    if (token.type !== 'operator' || !OPERATOR_ARITIES.has(token.value)) throw invalid();
    const operator = token.value;
    const arity = OPERATOR_ARITIES.get(operator);
    if (operands.length !== arity) throw invalid(`Inserted operator ${operator} has the wrong operand arity.`);
    operands.length = 0;
    if (operator === 'q') {
      graphicsDepth += 1;
      if (graphicsDepth > 32) throw invalid();
    } else if (operator === 'Q') {
      if (graphicsDepth < 1) throw invalid();
      graphicsDepth -= 1;
    }
    operatorCounts.set(operator, (operatorCounts.get(operator) ?? 0) + 1);
  }
  if (operands.length !== 0 || graphicsDepth !== 0) throw invalid();
  return Object.freeze({
    bytes: Buffer.from(content),
    digest: sha256(content),
    operatorCounts: Object.freeze(Object.fromEntries([...operatorCounts].sort(([a], [b]) => a.localeCompare(b)))),
    tokenCount: tokenized.tokens.length,
  });
}

function normalizeRequest(value = {}) {
  const request = exactObject(value, ['profile', 'edits'], ['tokenizerLimits', 'sourceSha256']);
  if (request.profile !== PDF_PAGE_CONTENT_FOUNDATION_PROFILE) throw invalid();
  const edits = arrayValues(request.edits);
  if (edits.length < 1 || edits.length > PDF_PAGE_CONTENT_FOUNDATION_LIMITS.maxEdits) throw invalid();
  const tokenizerLimits = normalizeLimits(request.tokenizerLimits);
  const normalized = edits.map((value) => {
    const edit = exactObject(value, ['page', 'position', 'content']);
    const page = numberValue(edit.page, 1, PDF_PAGE_CONTENT_FOUNDATION_LIMITS.maxPages);
    if (edit.position !== 'prepend' && edit.position !== 'append') throw invalid();
    const content = Buffer.isBuffer(edit.content) ? Buffer.from(edit.content)
      : (typeof edit.content === 'string' ? Buffer.from(edit.content, 'latin1') : null);
    if (!Buffer.isBuffer(content)) throw invalid();
    const validation = validateInsertedContent(content, tokenizerLimits);
    return Object.freeze({ page, position: edit.position, content, validation });
  });
  const sourceSha256 = request.sourceSha256;
  if (sourceSha256 !== undefined && (typeof sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sourceSha256))) throw invalid();
  return Object.freeze({ profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE, edits: Object.freeze(normalized), tokenizerLimits, sourceSha256 });
}

function checkedSource(sourceBytes, sourceSha256) {
  if (!Buffer.isBuffer(sourceBytes)
    || (typeof SharedArrayBuffer !== 'undefined' && sourceBytes.buffer instanceof SharedArrayBuffer)
    || sourceBytes.length > PDF_PAGE_CONTENT_FOUNDATION_LIMITS.maxSourceBytes) throw invalid();
  if (sourceSha256 !== undefined && sha256(sourceBytes) !== sourceSha256) throw invalid();
  try { return parsePdfStructure(sourceBytes); } catch { throw unsupported(); }
}
function reference(value) { try { return pdfReference(value); } catch { throw unsupported(); } }
function normalizeContentReferences(value) {
  if (value === undefined) return Object.freeze([]);
  if (value?.type === 'ref') return Object.freeze([reference(value)]);
  if (value?.type === 'array') return Object.freeze(value.values.map((entry) => reference(entry)));
  throw unsupported();
}
function sequenceFor(value, edits, referencesByEdit) {
  const original = normalizeContentReferences(value);
  const prepends = edits.filter(({ position }) => position === 'prepend').map((_, index) => referencesByEdit[index]);
  const appends = edits.filter(({ position }) => position === 'append').map((_, index) => referencesByEdit[index]);
  return array([...prepends, ...original, ...appends]);
}
function pageSnapshot(page) {
  return Object.freeze({ reference: reference(page.reference), mediaBox: [...page.mediaBox], cropBox: [...page.cropBox], rotate: page.rotate });
}

export function collectPageContentFoundationState(sourceBytes, requestValue = {}) {
  const request = normalizeRequest(requestValue);
  const structure = checkedSource(sourceBytes, request.sourceSha256);
  const treeStructure = structure.xrefFlavor === 'classic' || structure.xrefFlavor === undefined ? parseClassicPdfStructure(sourceBytes) : structure;
  const tree = resolvePdfPageTree({ structure: treeStructure, limits: { maxPages: PDF_PAGE_CONTENT_FOUNDATION_LIMITS.maxPages } });
  const selectedPages = new Set(request.edits.map(({ page }) => page));
  if ([...selectedPages].some((page) => !tree.pages[page - 1])) throw unsupported();
  const contentUse = new Map();
  const contentStreams = new Map();
  for (const page of tree.pages) {
    for (const content of page.contents) {
      const normalizedLength = content.stream.value.entries.get('Length');
      if (normalizedLength?.type !== 'number' || !Number.isSafeInteger(normalizedLength.value) || normalizedLength.value !== content.streamLength) throw unsupported('Content stream length is ambiguous.');
      if (content.stream.value.entries.has('Filter') || content.stream.value.entries.has('DecodeParms')) throw unsupported('Filtered content streams are unsupported.');
      let tokenized;
      try { tokenized = tokenizePdfContentStream({ sourceBytes, stream: content.stream, limits: request.tokenizerLimits }); } catch (error) { throw unsupported(error?.message); }
      const key = referenceText(content.reference);
      contentUse.set(key, (contentUse.get(key) ?? 0) + 1);
      contentStreams.set(key, Object.freeze({ reference: content.reference, streamLength: content.streamLength, streamStart: content.streamStart, digest: sha256(tokenized.bytes), tokenCount: tokenized.tokens.length }));
    }
  }
  if ([...contentUse.values()].some((count) => count !== 1)) throw unsupported('Content streams are shared, missing, or aliased.');
  return Object.freeze({ request, structure, tree, selectedPages, pageCount: tree.pageCount, contentUse, contentStreams, pageSnapshots: Object.freeze(tree.pages.map(pageSnapshot)), tokenizerLimits: request.tokenizerLimits });
}

function expectedPageSequences(state, referencesByEdit) {
  const byPage = new Map();
  for (const [index, edit] of state.request.edits.entries()) {
    const list = byPage.get(edit.page) ?? [];
    list.push({ edit, reference: referencesByEdit[index] });
    byPage.set(edit.page, list);
  }
  return new Map(state.tree.pages.map((page, index) => {
    const edits = byPage.get(index + 1) ?? [];
    const prepends = edits.filter(({ edit }) => edit.position === 'prepend').map(({ reference }) => reference);
    const appends = edits.filter(({ edit }) => edit.position === 'append').map(({ reference }) => reference);
    return [index + 1, [...prepends, ...normalizeContentReferences(page.page.value.entries.get('Contents')), ...appends]];
  }));
}

function proofForEdits(sourceBytes, outputBytes, state, transaction, referencesByEdit) {
  if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
  let output;
  try { output = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: state.structure, expectedRevision: transaction.revision }).outputStructure; } catch (error) { if (error?.code === 'INVALID_CLASSIC_INCREMENTAL_OUTPUT') throw invalidOutput(); throw error; }
  const outputTreeStructure = output.xrefFlavor === 'classic' || output.xrefFlavor === undefined ? parseClassicPdfStructure(outputBytes) : output;
  const outputTree = resolvePdfPageTree({ structure: outputTreeStructure, limits: { maxPages: PDF_PAGE_CONTENT_FOUNDATION_LIMITS.maxPages } });
  if (outputTree.pageCount !== state.pageCount || outputTree.pages.length !== state.tree.pages.length) throw invalidOutput();
  for (let index = 0; index < state.tree.pages.length; index += 1) {
    const before = state.pageSnapshots[index]; const after = pageSnapshot(outputTree.pages[index]);
    if (!sameReference(before.reference, after.reference) || before.rotate !== after.rotate || before.mediaBox.some((v, i) => v !== after.mediaBox[i]) || before.cropBox.some((v, i) => v !== after.cropBox[i])) throw invalidOutput();
  }
  const expectedSequences = expectedPageSequences(state, referencesByEdit);
  for (const page of outputTree.pages) {
    const observed = normalizeContentReferences(pdfDictionary(resolvePdfObject(output, page.reference).value).get('Contents'));
    const expected = expectedSequences.get(page.index + 1);
    if (observed.length !== expected.length || !observed.every((entry, index) => sameReference(entry, expected[index]))) throw invalidOutput();
  }
  for (const [, candidate] of state.contentStreams) {
    const sourceSlice = sourceBytes.subarray(candidate.streamStart, candidate.streamStart + candidate.streamLength);
    const written = resolvePdfObject(output, candidate.reference);
    if (!written.stream || written.streamLength !== candidate.streamLength || !outputBytes.subarray(written.streamStart, written.streamStart + written.streamLength).equals(sourceSlice) || sha256(sourceSlice) !== candidate.digest) throw invalidOutput();
  }
  const editProofs = state.request.edits.map((edit, index) => {
    const ref = referencesByEdit[index]; const stream = resolvePdfObject(output, ref);
    const bytes = outputBytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength);
    const validation = validateInsertedContent(bytes, state.tokenizerLimits);
    if (!stream.stream || !bytes.equals(edit.content) || stream.streamLength !== edit.content.length || validation.digest !== edit.validation.digest || JSON.stringify(validation.operatorCounts) !== JSON.stringify(edit.validation.operatorCounts)) throw invalidOutput();
    return Object.freeze({ index, page: edit.page, position: edit.position, reference: referenceText(ref), objectNumber: ref.object, generation: ref.generation, bytes: bytes.length, sha256: validation.digest, tokenCount: validation.tokenCount, operatorCounts: validation.operatorCounts });
  });
  return Object.freeze({
    profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE, sourceSha256: sha256(sourceBytes), outputSha256: sha256(outputBytes), sourcePrefixPreserved: true,
    pageCount: state.pageCount, edits: editProofs, insertedStreams: editProofs, outputBytes: outputBytes.length, sourceBytes: sourceBytes.length,
    sourcePageObjectNumber: state.tree.pages[state.request.edits[0].page - 1].reference.object,
    sourcePageGeneration: state.tree.pages[state.request.edits[0].page - 1].reference.generation,
    sourcePageReference: referenceText(state.tree.pages[state.request.edits[0].page - 1].reference),
    sourceContentStreams: state.contentStreams.size, sourceContentStreamReferences: Object.freeze([...state.contentStreams.keys()]),
    originalContentStreams: Object.freeze([...state.contentStreams].map(([reference, value]) => Object.freeze({ reference, bytes: value.streamLength, sha256: value.digest, tokenCount: value.tokenCount }))),
    revisionCount: output.revisions.length, appendedBytes: transaction.revision.bytes.length, appendedXrefOffset: transaction.revision.xrefOffset, tokenizerLimits: state.tokenizerLimits,
  });
}

function appendEdits(sourceBytes, requestValue = {}) {
  const state = collectPageContentFoundationState(sourceBytes, requestValue); const request = state.request;
  const additions = request.edits.map((edit, index) => ({ id: `content-${String(index).padStart(2, '0')}`, value: dict([['Length', numberPdf(edit.content.length)]]), streamBytes: edit.content }));
  const handles = additions.map(({ id }) => pendingPdfObjectReference(id));
  const byPage = new Map();
  request.edits.forEach((edit, index) => { const list = byPage.get(edit.page) ?? []; list.push({ edit, reference: handles[index] }); byPage.set(edit.page, list); });
  const updates = [...byPage.entries()].map(([pageNumber, edits]) => {
    const page = state.tree.pages[pageNumber - 1];
    const prepends = edits.filter(({ edit }) => edit.position === 'prepend').map(({ reference }) => reference);
    const appends = edits.filter(({ edit }) => edit.position === 'append').map(({ reference }) => reference);
    return { reference: page.reference, value: dict([...page.page.value.entries, ['Contents', array([...prepends, ...normalizeContentReferences(page.page.value.entries.get('Contents')), ...appends])]]) };
  });
  const transaction = planPdfObjectTransaction({ sourceBytes, sourceStructure: state.structure, updates, additions, info: { kind: 'preserve' }, changingId: state.structure.id ? changedId(sourceBytes, request) : null });
  return Object.freeze({ revision: transaction.revision, outputBytes: Buffer.concat([sourceBytes, transaction.revision.bytes]), state, request, referencesByEdit: Object.freeze(handles.map((_, index) => transaction.referencesById[additions[index].id])) });
}

export function writePageContentFoundation(sourceBytes, requestValue = {}) {
  try { const result = appendEdits(sourceBytes, requestValue); const proof = proofForEdits(sourceBytes, result.outputBytes, result.state, result, result.referencesByEdit); return Object.freeze({ bytes: result.outputBytes, proof }); }
  catch (error) { if (['INVALID_PAGE_CONTENT_FOUNDATION', 'INVALID_PAGE_CONTENT_FOUNDATION_OUTPUT', 'UNSUPPORTED_PAGE_CONTENT_FOUNDATION'].includes(error?.code)) throw error; throw unsupported(); }
}
export function inspectPageContentFoundation(sourceBytes, outputBytes, requestValue = {}) {
  try { const expected = writePageContentFoundation(sourceBytes, requestValue); if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(expected.bytes)) throw invalidOutput(); return expected.proof; }
  catch (error) { if (error?.code === 'INVALID_PAGE_CONTENT_FOUNDATION_OUTPUT') throw error; if (['INVALID_PAGE_CONTENT_FOUNDATION', 'UNSUPPORTED_PAGE_CONTENT_FOUNDATION'].includes(error?.code)) throw invalidOutput(); throw error; }
}
export const writeIncrementalPdfPageContent = writePageContentFoundation;
export const inspectIncrementalPdfPageContent = inspectPageContentFoundation;
