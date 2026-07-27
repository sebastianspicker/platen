import { createHash } from 'node:crypto';
import {
  pdfDictionary, pdfReference, serializePdfValue,
} from './pdf-classic-syntax.mjs';
import { CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import {
  PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE,
  normalizePdfAccessibilityLinksBookmarks,
} from './pdf-accessibility-links-bookmarks-contract.mjs';

const MAX_PAGES = 100;
const MAX_PAGE_TREE_DEPTH = 16;
const MAX_PAGE_TREE_NODES = 256;
const MAX_ANNOTATIONS = 256;
const MAX_OUTLINE_ITEMS = 256;
const CATALOG_REJECTED = new Set([
  'AA', 'AcroForm', 'AF', 'Collection', 'Encrypt', 'JavaScript', 'Metadata', 'Names',
  'OCProperties', 'OpenAction', 'Perms', 'StructTreeRoot', 'URI', 'XFA',
]);
const UNSAFE_KEYS = new Set([
  'A', 'AA', 'AF', 'Action', 'ByteRange', 'EF', 'EmbeddedFiles', 'Encrypt', 'FS', 'JS',
  'JavaScript', 'Launch', 'Metadata', 'Movie', 'OC', 'OCProperties', 'OpenAction', 'Perms', 'RichMediaContent',
  'Sound', 'SubmitForm', 'URI', 'XFA',
]);
const UNSAFE_TYPES = new Set(['Action', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Sig']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'PDF is outside the supported accessibility links/bookmarks subset.') { return failure('UNSUPPORTED_ACCESSIBILITY_LINKS_BOOKMARKS_PDF', message); }
function invalidOutput(message = 'Accessibility links/bookmarks output proof failed.') { return failure('INVALID_ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT', message); }
function sameReference(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function refText(value) { return `${value.object} ${value.generation} R`; }
function pdfName(value) { return Object.freeze({ type: 'name', value }); }
function pdfString(value) {
  const bytes = Buffer.alloc(2 + value.length * 2); bytes.writeUInt16BE(0xFEFF, 0);
  for (let index = 0; index < value.length; index += 1) bytes.writeUInt16BE(value.charCodeAt(index), 2 + index * 2);
  return Object.freeze({ type: 'string', format: 'hex', bytes });
}
function pdfArray(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function pdfDict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function resolved(structure, value) { return resolvePdfObject(structure, pdfReference(value)); }

function parseSource(bytes, expectedSha256) {
  if (!Buffer.isBuffer(bytes) || (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)) throw unsupported();
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw unsupported('The locator source digest does not match the supplied PDF bytes.');
  try {
    const structure = parsePdfStructure(bytes);
    if (structure.xrefFlavor !== 'classic' || structure.revisions.length !== 1
      || structure.compressedObjects.size !== 0 || structure.revisions[0].trailer.has('Encrypt')) throw unsupported('Only one classic, unencrypted, non-compressed revision is supported.');
    return structure;
  } catch (error) { if (error?.code === 'UNSUPPORTED_ACCESSIBILITY_LINKS_BOOKMARKS_PDF') throw error; throw unsupported(); }
}

function rejectUnsafeObjects(structure) {
  visitPdfObjects(structure, (object) => {
    if (object.stream) {
      const type = object.value?.entries?.get('Type');
      if (type?.type === 'name' && ['Metadata', 'EmbeddedFile', 'ObjStm', 'XRef'].includes(type.value)) throw unsupported('Metadata, attachment, or compressed streams are unsupported.');
    }
    if (object.value?.type !== 'dict') return;
    const entries = object.value.entries;
    const type = entries.get('Type'); const subtype = entries.get('Subtype');
    if (type?.type === 'name' && UNSAFE_TYPES.has(type.value)
      || subtype?.type === 'name' && subtype.value === 'Widget'
      || entries.has('FT') || [...UNSAFE_KEYS].some((key) => entries.has(key))) throw unsupported('Active content, forms, signatures, or external actions are unsupported.');
  });
}

function directDestination(value, pages) {
  if (value?.type !== 'array' || value.values.length !== 2 || value.values[1]?.type !== 'name' || value.values[1].value !== 'Fit') throw unsupported('Only direct internal /Fit destinations are supported.');
  const target = pdfReference(value.values[0]);
  const targetPage = pages.findIndex((page) => sameReference(page.reference, target));
  if (targetPage < 0) throw unsupported('A link or bookmark destination does not resolve to a source page.');
  return Object.freeze({ reference: target, page: targetPage + 1 });
}

function collectPages(structure) {
  const catalog = resolved(structure, structure.root);
  if (catalog.stream) throw unsupported();
  const root = pdfDictionary(catalog.value);
  if (root.get('Type')?.type !== 'name' || root.get('Type').value !== 'Catalog'
    || [...CATALOG_REJECTED].some((key) => root.has(key))) throw unsupported();
  rejectUnsafeObjects(structure);
  const pagesRoot = pdfReference(root.get('Pages')); const pages = []; const seen = new Set();
  function visit(reference, parent, depth) {
    if (depth > MAX_PAGE_TREE_DEPTH || seen.size >= MAX_PAGE_TREE_NODES || seen.has(refText(reference))) throw unsupported();
    seen.add(refText(reference)); const object = resolved(structure, reference);
    if (object.stream) throw unsupported(); const entries = pdfDictionary(object.value); const type = entries.get('Type');
    if (type?.type !== 'name' || !['Page', 'Pages'].includes(type.value)) throw unsupported();
    if (parent === null ? entries.has('Parent') : !sameReference(pdfReference(entries.get('Parent')), parent)) throw unsupported();
    if (type.value === 'Page') {
      if (pages.length >= MAX_PAGES || entries.has('AA') || entries.has('A') || entries.has('Dur') || entries.has('Trans')) throw unsupported();
      const annotations = [];
      if (entries.has('Annots')) {
        const annotsValue = entries.get('Annots');
        const annots = annotsValue.type === 'ref' ? resolved(structure, annotsValue).value : annotsValue;
        if (annots?.type !== 'array' || annots.values.length > MAX_ANNOTATIONS) throw unsupported();
        const annotationReferences = new Set();
        for (const [annotationIndex, entry] of annots.values.entries()) {
          const annotationReference = pdfReference(entry); if (annotationReferences.has(refText(annotationReference))) throw unsupported('Page annotation references are ambiguous.'); annotationReferences.add(refText(annotationReference)); const annotationObject = resolved(structure, annotationReference);
          if (annotationObject.stream) throw unsupported(); const annotation = pdfDictionary(annotationObject.value);
          if (annotation.get('Type')?.type !== 'name' || annotation.get('Type').value !== 'Annot') throw unsupported();
          if (annotation.get('Subtype')?.type === 'name' && annotation.get('Subtype').value === 'Link') {
            if (annotation.has('A') || annotation.has('AA') || annotation.has('URI') || annotation.has('Dest') === false) throw unsupported('Only direct internal link annotations are supported.');
            annotations.push({ kind: 'link', annotationIndex, annotationReference, annotation });
          }
        }
      }
      pages.push(Object.freeze({ reference, entries, annotations })); return 1;
    }
    const kids = entries.get('Kids'); if (kids?.type !== 'array' || kids.values.length < 1) throw unsupported();
    let count = 0; for (const child of kids.values) count += visit(pdfReference(child), reference, depth + 1);
    if (entries.get('Count')?.type !== 'number' || !entries.get('Count').integer || entries.get('Count').value !== count) throw unsupported(); return count;
  }
  visit(pagesRoot, null, 0);
  // Link destinations may point forward in page order; resolve them now.
  const normalizedPages = pages.map((page) => Object.freeze({
    ...page,
    annotations: Object.freeze(page.annotations.map((link) => Object.freeze({
      ...link,
      destination: directDestination(link.annotation.get('Dest'), pages),
    }))),
  }));
  return Object.freeze({ catalog, root, pages: Object.freeze(normalizedPages) });
}

function locatorFingerprint(sourceBytes, kind, reference, detail) {
  return createHash('sha256').update('Platen accessibility locator v1\0', 'utf8')
    .update(createHash('sha256').update(sourceBytes).digest()).update(kind, 'utf8').update('\0', 'utf8')
    .update(refText(reference), 'utf8').update('\0', 'utf8').update(JSON.stringify(detail), 'utf8').digest('hex');
}

function collectOutlines(sourceBytes, structure, state) {
  const outlineReference = state.root.get('Outlines');
  if (!outlineReference) return Object.freeze({ rootReference: null, items: Object.freeze([]) });
  const outlineObject = resolved(structure, outlineReference); if (outlineObject.stream) throw unsupported();
  const outline = pdfDictionary(outlineObject.value); const first = outline.get('First');
  if (!first) { if (outline.has('Last')) throw unsupported('Outline graph is incomplete.'); return Object.freeze({ rootReference: pdfReference(outlineReference), items: Object.freeze([]) }); }
  const items = []; const seen = new Set();
  // Traverse sibling lists recursively while retaining only opaque source-bound locators.
  function walk(reference, parent, path) {
    let current = reference; let index = 0; let previous = null; let last = null; let count = 0;
    while (current) {
      const key = refText(current); if (seen.has(key) || items.length >= MAX_OUTLINE_ITEMS) throw unsupported(); seen.add(key);
      const object = resolved(structure, current); if (object.stream) throw unsupported(); const entries = pdfDictionary(object.value);
      if (!sameReference(pdfReference(entries.get('Parent')), parent) || entries.get('Title')?.type !== 'string') throw unsupported();
      if (!previous && entries.has('Prev')) throw unsupported('Outline graph has an unexpected previous sibling.');
      if (previous && !sameReference(pdfReference(entries.get('Prev')), previous)) throw unsupported();
      const destination = directDestination(entries.get('Dest'), state.pages);
      const item = { reference: current, entries, path: [...path, index], destination, fingerprint: locatorFingerprint(sourceBytes, 'bookmark', current, { path: [...path, index] }) };
      items.push(item);
      let childCount = 0;
      if (entries.get('First')) {
        if (!entries.get('Last')) throw unsupported();
        const child = walk(pdfReference(entries.get('First')), current, [...path, index, 'children']);
        if (!sameReference(pdfReference(entries.get('Last')), child.last)) throw unsupported();
        childCount = child.count;
      }
      else if (entries.has('Last')) throw unsupported();
      if (entries.has('Count')) {
        const declared = entries.get('Count');
        if (declared?.type !== 'number' || !declared.integer || Math.abs(declared.value) !== childCount) throw unsupported('Outline item counts are inconsistent.');
      }
      count += 1 + childCount;
      last = item.reference; current = entries.get('Next') ? pdfReference(entries.get('Next')) : null; previous = item.reference; index += 1;
    }
    return Object.freeze({ last, count });
  }
  const walked = walk(pdfReference(first), pdfReference(outlineReference), []);
  if (outline.get('Count')) {
    const declared = outline.get('Count');
    if (declared?.type !== 'number' || !declared.integer || Math.abs(declared.value) !== walked.count) throw unsupported('Outline counts are inconsistent.');
  }
  if (outline.get('Last') && !sameReference(pdfReference(outline.get('Last')), walked.last)) throw unsupported();
  return Object.freeze({ rootReference: pdfReference(outlineReference), items: Object.freeze(items.map((item) => Object.freeze(item))) });
}

function inventory(sourceBytes, structure) {
  const state = collectPages(structure); const links = [];
  for (const page of state.pages) for (const link of page.annotations) {
    links.push(Object.freeze({ ...link, page: state.pages.indexOf(page) + 1, fingerprint: locatorFingerprint(sourceBytes, 'link', link.annotationReference, { page: state.pages.indexOf(page) + 1, annotationIndex: link.annotationIndex }) }));
  }
  const outlines = collectOutlines(sourceBytes, structure, state);
  return Object.freeze({ ...state, links: Object.freeze(links), outlines });
}

function changedId(source, request) { return createHash('sha256').update('Platen accessibility links/bookmarks ID v1\0', 'utf8').update(createHash('sha256').update(source).digest()).update(JSON.stringify(request), 'utf8').digest().subarray(0, 16); }

function locate(state, request) {
  const linkMap = new Map(state.links.map((entry) => [entry.fingerprint, entry])); const bookmarkMap = new Map(state.outlines.items.map((entry) => [entry.fingerprint, entry]));
  const links = request.links.map((entry) => { const found = linkMap.get(entry.locator.fingerprint); if (!found || entry.targetPage > state.pages.length) throw unsupported('A link locator is stale, forged, or ambiguous.'); return Object.freeze({ ...entry, target: found }); });
  const bookmarks = request.bookmarks.map((entry) => { const found = bookmarkMap.get(entry.locator.fingerprint); if (!found || entry.targetPage > state.pages.length) throw unsupported('A bookmark locator is stale, forged, or ambiguous.'); return Object.freeze({ ...entry, target: found }); });
  return Object.freeze({ links: Object.freeze(links), bookmarks: Object.freeze(bookmarks) });
}

function canonicalAppend(source, structure, state, request) {
  const selected = locate(state, request); const updates = [];
  for (const entry of selected.links) {
    const next = new Map(entry.target.annotation); next.set('Contents', pdfString(entry.purpose));
    next.set('Dest', pdfArray([state.pages[entry.targetPage - 1].reference, pdfName('Fit')]));
    updates.push({ reference: entry.target.annotationReference, value: pdfDict(next) });
  }
  for (const entry of selected.bookmarks) {
    const next = new Map(entry.target.entries); next.set('Title', pdfString(entry.title));
    next.set('Dest', pdfArray([state.pages[entry.targetPage - 1].reference, pdfName('Fit')]));
    updates.push({ reference: entry.target.reference, value: pdfDict(next) });
  }
  try {
    const transaction = planPdfObjectTransaction({ sourceBytes: source, sourceStructure: structure, updates, additions: [], info: { kind: 'preserve' }, changingId: structure.id ? changedId(source, request) : null });
    return Object.freeze({ revision: transaction.revision, bytes: transaction.revision.bytes, selected, updates });
  } catch { throw unsupported(); }
}

function proof(source, output, append, request) {
  const links = request.links.map((entry) => Object.freeze({
    locatorSha256: entry.locator.fingerprint,
    purposeSha256: createHash('sha256').update(entry.purpose, 'utf8').digest('hex'),
    targetPage: entry.targetPage,
  }));
  const bookmarks = request.bookmarks.map((entry) => Object.freeze({
    locatorSha256: entry.locator.fingerprint,
    titleSha256: createHash('sha256').update(entry.title, 'utf8').digest('hex'),
    targetPage: entry.targetPage,
  }));
  return Object.freeze({
    profile: PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE,
    sourceBytes: source.length, outputBytes: output.buffer.length,
    appendedBytes: output.buffer.length - source.length, sourcePrefixPreserved: true,
    revisionCount: output.revisions.length, sourceRevisionCount: output.revisions.length - 1,
    previousXrefOffset: output.revisions[1].offset, appendedXrefOffset: output.revisions[0].offset,
    links: Object.freeze(links), bookmarks: Object.freeze(bookmarks),
    updatedObjectNumbers: Object.freeze(append.updates.map(({ reference }) => reference.object)),
    effectiveSize: output.finalSize, rootPreserved: true, infoPreserved: true,
    hierarchyPreserved: true, geometryPreserved: true,
    idPolicy: source.id ? 'permanent-preserved-changing-updated' : 'absent',
  });
}

function inspectWithSource(sourceBytes, outputBytes, request, source, state) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const append = canonicalAppend(sourceBytes, source, state, request);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: source, expectedRevision: append.revision }).outputStructure;
    const outputState = inventory(sourceBytes, output);
    if (output.revisions.length !== source.revisions.length + 1 || output.revisions[0].entries.length !== append.updates.length || output.finalSize !== source.finalSize || !sameReference(output.root, source.root) || Boolean(output.info) !== Boolean(source.info) || output.info && !sameReference(output.info, source.info)) throw invalidOutput();
    const selected = locate(outputState, request); const updated = new Set(append.updates.map(({ reference }) => refText(reference)));
    for (const [number, before] of source.effective) { const after = output.effective.get(number); if (!after || !updated.has(`${number} ${before.generation} R`) && (after.status !== before.status || after.generation !== before.generation || after.offset !== before.offset)) throw invalidOutput(); }
    for (const entry of selected.links) { const link = pdfDictionary(resolved(output, entry.target.annotationReference).value); if (link.get('Contents')?.type !== 'string' || directDestination(link.get('Dest'), outputState.pages).page !== entry.targetPage) throw invalidOutput(); }
    for (const entry of selected.bookmarks) { const bookmark = pdfDictionary(resolved(output, entry.target.reference).value); const destination = directDestination(bookmark.get('Dest'), outputState.pages); if (bookmark.get('Title')?.type !== 'string' || destination.page !== entry.targetPage) throw invalidOutput(); }
    const result = proof(sourceBytes, output, append, request); const expectedId = source.id ? changedId(sourceBytes, request) : null;
    if ((source.id === null) !== (output.id === null) || source.id && (!output.id[0].equals(source.id[0]) || !output.id[1].equals(expectedId))) throw invalidOutput();
    return result;
  } catch (error) { if (error?.code === 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT') throw error; throw invalidOutput(); }
}

export function inspectPdfAccessibilityLinksBookmarks(sourceBytes, outputBytes, requestValue) {
  const request = normalizePdfAccessibilityLinksBookmarks(requestValue); const source = parseSource(sourceBytes, request.sourceSha256); const state = inventory(sourceBytes, source); return inspectWithSource(sourceBytes, outputBytes, request, source, state);
}

export function writePdfAccessibilityLinksBookmarks(sourceBytes, requestValue) {
  const request = normalizePdfAccessibilityLinksBookmarks(requestValue); const source = parseSource(sourceBytes, request.sourceSha256); const state = inventory(sourceBytes, source); const append = canonicalAppend(sourceBytes, source, state, request); const bytes = Buffer.concat([sourceBytes, append.bytes]); return Object.freeze({ bytes, proof: inspectWithSource(sourceBytes, bytes, request, source, state) });
}

export const writeAccessibilityLinksBookmarks = writePdfAccessibilityLinksBookmarks;
export const inspectAccessibilityLinksBookmarks = inspectPdfAccessibilityLinksBookmarks;
export function inspectPdfAccessibilityLinksBookmarksSource(sourceBytes, sourceSha256) { const source = parseSource(sourceBytes, sourceSha256 ?? createHash('sha256').update(sourceBytes).digest('hex')); const state = inventory(sourceBytes, source); return Object.freeze({ links: Object.freeze(state.links.map(({ fingerprint, page, annotationIndex, destination }) => Object.freeze({ fingerprint, page, annotationIndex, targetPage: destination.page }))), bookmarks: Object.freeze(state.outlines.items.map(({ fingerprint, destination, path }) => Object.freeze({ fingerprint, targetPage: destination.page, path: Object.freeze(path) }))), pageCount: state.pages.length }); }
