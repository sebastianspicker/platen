import { createHash } from 'node:crypto';
import {
  pdfDictionary, pdfReference, serializePdfValue,
} from './pdf-classic-syntax.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject,
} from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import {
  INCREMENTAL_PAGE_TRANSITION_PROFILE,
  normalizeIncrementalPageTransition,
} from './pdf-incremental-page-transition-contract.mjs';

const MAX_PAGE_TREE_DEPTH = 16;
const MAX_PAGE_TREE_NODES = 256;
const MAX_PAGES = 100;
const CATALOG_REJECTED_KEYS = new Set([
  'AA', 'AcroForm', 'AF', 'Collection', 'Encrypt', 'EmbeddedFiles', 'JavaScript',
  'Metadata', 'Names', 'OpenAction', 'Outlines', 'Perms', 'URI', 'XFA',
]);
const UNSAFE_KEYS = new Set([
  'A', 'AA', 'Action', 'ByteRange', 'Encrypt', 'EmbeddedFiles', 'FS', 'JS',
  'JavaScript', 'OpenAction', 'Perms', 'Sig', 'XFA',
]);
const UNSAFE_TYPES = new Set(['Action', 'EmbeddedFile', 'Filespec', 'Sig', 'Widget']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'PDF is outside the supported bounded page-transition subset.') {
  return failure('UNSUPPORTED_INCREMENTAL_PAGE_TRANSITION_PDF', message);
}
function invalidOutput(message = 'Incremental page-transition output proof failed.') {
  return failure('INVALID_INCREMENTAL_PAGE_TRANSITION_OUTPUT', message);
}
function sameReference(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function referenceText(reference) { return `${reference.object} ${reference.generation} R`; }

function parseStructure(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) throw unsupported();
  try {
    const structure = parsePdfStructure(bytes);
    if (structure.xrefFlavor !== 'classic' || structure.revisions.length !== 1
      || structure.compressedObjects.size !== 0 || structure.revisions[0].trailer.has('Encrypt')) throw unsupported('Only one classic, unencrypted, non-compressed PDF revision is supported.');
    return structure;
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_INCREMENTAL_PAGE_TRANSITION_PDF') throw error;
    throw unsupported();
  }
}

function rejectUnsafeValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value.type === 'dict') {
    const type = value.entries.get('Type');
    if (type?.type === 'name' && UNSAFE_TYPES.has(type.value)) throw unsupported('Active, signed, or form content is unsupported.');
    for (const [key, child] of value.entries) {
      if (UNSAFE_KEYS.has(key)) throw unsupported('Active, signed, or encrypted content is unsupported.');
      rejectUnsafeValue(child, seen);
    }
  } else if (value.type === 'array') {
    for (const child of value.values) rejectUnsafeValue(child, seen);
  }
}

function collectPages(structure) {
  try {
    const catalog = resolvePdfObject(structure, structure.root);
    if (catalog.stream) throw unsupported();
    const catalogEntries = pdfDictionary(catalog.value);
    if (catalogEntries.get('Type')?.type !== 'name' || catalogEntries.get('Type').value !== 'Catalog'
      || [...CATALOG_REJECTED_KEYS].some((key) => catalogEntries.has(key))) throw unsupported();
    visitPdfObjects(structure, (object) => rejectUnsafeValue(object.value));
    const pagesReference = pdfReference(catalogEntries.get('Pages'));
    const pages = []; const seen = new Set();
    function visit(reference, parent, depth) {
      if (depth > MAX_PAGE_TREE_DEPTH || seen.size >= MAX_PAGE_TREE_NODES) throw unsupported();
      const key = referenceText(reference); if (seen.has(key)) throw unsupported(); seen.add(key);
      const object = resolvePdfObject(structure, reference);
      if (object.stream) throw unsupported();
      const entries = pdfDictionary(object.value); const type = entries.get('Type');
      if (type?.type !== 'name' || !['Pages', 'Page'].includes(type.value)) throw unsupported();
      if (parent === null) {
        if (entries.has('Parent')) throw unsupported();
      } else if (!sameReference(pdfReference(entries.get('Parent')), parent)) throw unsupported();
      if (type.value === 'Page') {
        pages.push(Object.freeze({ reference, entries: Object.freeze(entries) }));
        if (pages.length > MAX_PAGES) throw unsupported();
        return 1;
      }
      const kids = entries.get('Kids');
      if (kids?.type !== 'array' || kids.values.length === 0) throw unsupported();
      let count = 0;
      for (const child of kids.values) count += visit(pdfReference(child), reference, depth + 1);
      if (entries.get('Count')?.type !== 'number' || !entries.get('Count').integer
        || entries.get('Count').value !== count) throw unsupported();
      return count;
    }
    visit(pagesReference, null, 0);
    return Object.freeze(pages);
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_INCREMENTAL_PAGE_TRANSITION_PDF') throw error;
    throw unsupported();
  }
}

function changedId(source, request) {
  return createHash('sha256')
    .update('Platen incremental page transition ID v1\0', 'utf8')
    .update(createHash('sha256').update(source).digest())
    .update(JSON.stringify(request), 'utf8').digest().subarray(0, 16);
}

function transitionValue(request) {
  return Object.freeze({ type: 'dict', entries: new Map([
    ['Type', Object.freeze({ type: 'name', value: 'Trans' })],
    ['S', Object.freeze({ type: 'name', value: request.transition })],
    ['D', Object.freeze({ type: 'number', value: request.duration, integer: Number.isSafeInteger(request.duration), raw: String(request.duration) })],
  ]) });
}

function expectedPage(entries, request) {
  const next = new Map(entries); next.set('Trans', transitionValue(request));
  return Object.freeze({ type: 'dict', entries: next });
}

function selectedState(structure, request) {
  const pages = collectPages(structure);
  const selected = request.pages.map((page) => {
    const entry = pages[page - 1];
    if (!entry) throw failure('INVALID_INCREMENTAL_PAGE_TRANSITION', 'A selected transition page is outside the source document.');
    return Object.freeze({ page, ...entry });
  });
  return Object.freeze({ pages, selected });
}

function canonicalAppend(source, structure, state, request) {
  try {
    const revision = planPdfObjectTransaction({
      sourceBytes: source,
      sourceStructure: structure,
      updates: state.selected.map((page) => ({ reference: page.reference, value: expectedPage(page.entries, request) })),
      additions: [],
      info: { kind: 'preserve' },
      changingId: structure.id ? changedId(source, request) : null,
    }).revision;
    return Object.freeze({ revision, bytes: revision.bytes, xrefOffset: revision.xrefOffset });
  } catch { throw unsupported(); }
}

function withoutTransition(entries) {
  const copy = new Map(entries); copy.delete('Trans');
  return serializePdfValue({ type: 'dict', entries: copy });
}

function proof(source, output, append, state, request, idPolicy) {
  return Object.freeze({
    profile: INCREMENTAL_PAGE_TRANSITION_PROFILE,
    sourceBytes: source.length,
    outputBytes: output.buffer.length,
    appendedBytes: output.buffer.length - source.length,
    sourcePrefixPreserved: true,
    revisionCount: output.revisions.length,
    sourceRevisionCount: output.revisions.length - 1,
    previousXrefOffset: output.revisions[1].offset,
    appendedXrefOffset: append.xrefOffset,
    pageCount: state.pages.length,
    pages: Object.freeze(state.selected.map(({ page, reference }) => Object.freeze({ page, reference: referenceText(reference) }))),
    transition: request.transition,
    duration: request.duration,
    effectiveSize: output.finalSize,
    rootPreserved: true,
    infoPreserved: true,
    onlySelectedPagesChanged: true,
    pageDictionariesPreserved: true,
    idPolicy,
  });
}

function inspectWithSource(sourceBytes, outputBytes, request, source, state) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length
      || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput('Source prefix was not preserved.');
    const append = canonicalAppend(sourceBytes, source, state, request);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput('Output suffix did not match the canonical transaction.');
    const output = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: source, expectedRevision: append.revision }).outputStructure;
    if (output.revisions.length !== 2 || output.revisions[0].entries.length !== state.selected.length
      || output.revisions[0].offset !== append.xrefOffset || output.finalSize !== source.finalSize
      || !sameReference(output.root, source.root) || (source.info === null) !== (output.info === null)
      || (source.info && !sameReference(output.info, source.info))) throw invalidOutput();
    const selectedRefs = new Set(state.selected.map(({ reference }) => referenceText(reference)));
    for (const [number, entry] of source.effective) {
      const next = output.effective.get(number);
      if (!next || (!selectedRefs.has(`${number} ${entry.generation} R`)
        && (next.status !== entry.status || next.generation !== entry.generation
          || (entry.status === 'c' ? next.objectStream !== entry.objectStream || next.index !== entry.index : next.offset !== entry.offset)))) throw invalidOutput();
    }
    const outputPages = collectPages(output);
    if (outputPages.length !== state.pages.length || outputPages.some((page, index) => !sameReference(page.reference, state.pages[index].reference))) throw invalidOutput();
    const selectedNumbers = new Set(request.pages);
    for (let index = 0; index < state.pages.length; index += 1) {
      const before = state.pages[index]; const after = outputPages[index];
      if (selectedNumbers.has(index + 1)) {
        if (withoutTransition(before.entries) !== withoutTransition(after.entries)) throw invalidOutput();
        const trans = after.entries.get('Trans');
        if (serializePdfValue(trans) !== serializePdfValue(transitionValue(request))) throw invalidOutput();
      } else if (serializePdfValue({ type: 'dict', entries: before.entries }) !== serializePdfValue({ type: 'dict', entries: after.entries })) throw invalidOutput();
    }
    const idPolicy = source.id ? 'permanent-preserved-changing-updated' : 'absent';
    if ((source.id === null) !== (output.id === null) || (source.id && (!output.id[0].equals(source.id[0]) || !output.id[1].equals(changedId(sourceBytes, request))))) throw invalidOutput();
    return proof(sourceBytes, output, append, state, request, idPolicy);
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_PAGE_TRANSITION') throw error;
    if (error?.code === 'INVALID_INCREMENTAL_PAGE_TRANSITION_OUTPUT') throw error;
    throw invalidOutput();
  }
}

export function inspectIncrementalPdfPageTransition(sourceBytes, outputBytes, requestValue) {
  const request = normalizeIncrementalPageTransition(requestValue);
  const source = parseStructure(sourceBytes);
  return inspectWithSource(sourceBytes, outputBytes, request, source, selectedState(source, request));
}

export function writeIncrementalPdfPageTransition(sourceBytes, requestValue) {
  const request = normalizeIncrementalPageTransition(requestValue);
  const source = parseStructure(sourceBytes);
  const state = selectedState(source, request);
  const rows = source.revisions.reduce((sum, revision) => sum + revision.entries.length, 0);
  if (source.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions
    || rows + state.selected.length > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported();
  const append = canonicalAppend(sourceBytes, source, state, request);
  const bytes = Buffer.concat([sourceBytes, append.bytes]);
  return Object.freeze({ bytes, proof: inspectWithSource(sourceBytes, bytes, request, source, state) });
}

export const writePdfPageTransition = writeIncrementalPdfPageTransition;
export const inspectPdfPageTransition = inspectIncrementalPdfPageTransition;
