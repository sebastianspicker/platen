import { createHash } from 'node:crypto';
import {
  pdfDictionary, pdfInteger, pdfReference, serializePdfValue,
} from './pdf-classic-syntax.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject,
} from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import {
  INCREMENTAL_GOTO_LINK_PROFILE, normalizeIncrementalGoToLink,
} from './pdf-incremental-goto-link-contract.mjs';
import {
  INCREMENTAL_BATCH_LINK_PROFILE, normalizeIncrementalBatchGoToLinks,
} from './pdf-incremental-batch-link-contract.mjs';

const MAX_PAGE_TREE_DEPTH = 16;
const MAX_PAGE_TREE_NODES = 256;
const MAX_PAGES = 100;
const MAX_ANNOTATIONS = 50;
const CATALOG_REJECTED = new Set(['AA', 'AcroForm', 'AF', 'Collection', 'Metadata', 'Names', 'OpenAction', 'Outlines', 'Perms', 'URI']);
const PAGE_REJECTED = new Set(['AA', 'A', 'Dur', 'Metadata', 'PresSteps', 'Trans']);
const ANNOTATION_REJECTED = new Set(['A', 'AA', 'AF', 'AP', 'Dest', 'FS', 'JS', 'Launch', 'Movie', 'PA', 'Parent', 'Popup', 'RichMediaContent', 'Sound', 'SubmitForm', 'URI', '3DD']);
const PASSIVE_ANNOTATION_SUBTYPES = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink']);
const ACTIVE_ACTIONS = new Set([
  'GoTo', 'GoToR', 'GoToE', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide',
  'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript', 'SetOCGState',
  'Rendition', 'Trans', 'GoTo3DView',
]);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported() { return failure('UNSUPPORTED_INCREMENTAL_GOTO_LINK_PDF', 'PDF is outside the supported bounded incremental GoTo-link subset.'); }
function invalidOutput() { return failure('INVALID_INCREMENTAL_GOTO_LINK_OUTPUT', 'Incremental GoTo-link output proof failed.'); }
function sameReference(left, right) { return left.object === right.object && left.generation === right.generation; }
function referenceText(reference) { return `${reference.object} ${reference.generation} R`; }
function pdfName(value) { return Object.freeze({ type: 'name', value }); }
function pdfNumber(value) { return Object.freeze({ type: 'number', value, integer: true, raw: String(value) }); }
function pdfArray(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function pdfDict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }

function parseSource(sourceBytes) {
  if (!Buffer.isBuffer(sourceBytes) || (typeof SharedArrayBuffer !== 'undefined'
    && sourceBytes.buffer instanceof SharedArrayBuffer)) throw unsupported();
  try { return parsePdfStructure(sourceBytes); } catch { throw unsupported(); }
}

function directBox(value) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry?.type !== 'number'
    || !Number.isFinite(entry.value) || !Number.isInteger(entry.value))) throw unsupported();
  const box = value.values.map((entry) => entry.value);
  if (box[0] >= box[2] || box[1] >= box[3]) throw unsupported();
  return Object.freeze(box);
}

function contains(box, rect) {
  return box[0] <= rect.left && box[1] <= rect.bottom && box[2] >= rect.right && box[3] >= rect.top;
}

function rejectUnsafeObjects(structure) {
  visitPdfObjects(structure, (object) => {
    if (object.value?.type !== 'dict') return;
    const entries = object.value.entries; const type = entries.get('Type'); const subtype = entries.get('Subtype');
    const fieldType = entries.get('FT');
    if (structure.controlObjectNumbers?.has(object.reference.object)
      && type?.type === 'name' && ['XRef', 'ObjStm'].includes(type.value)) return;
    if ((type?.type === 'name' && ['Metadata', 'Sig', 'EmbeddedFile', 'Filespec'].includes(type.value))
      || (subtype?.type === 'name' && ['XML', 'Widget'].includes(subtype.value))
      || fieldType !== undefined || entries.has('EF') || entries.has('EmbeddedFiles')
      || entries.has('ByteRange') || entries.has('A') || entries.has('AA') || entries.has('JS')
      || entries.has('OpenAction') || (entries.get('S')?.type === 'name' && ACTIVE_ACTIONS.has(entries.get('S').value))) throw unsupported();
  });
}

function safeAnnotations(structure, value, admittedLink = null) {
  const resolved = value?.type === 'ref' ? resolvePdfObject(structure, pdfReference(value)) : { value, stream: false };
  if (resolved.stream || resolved.value?.type !== 'array' || resolved.value.values.length > MAX_ANNOTATIONS) throw unsupported();
  const references = resolved.value.values.map((entry) => pdfReference(entry));
  if (new Set(references.map(referenceText)).size !== references.length) throw unsupported();
  for (const reference of references) {
    const object = resolvePdfObject(structure, reference);
    if (object.stream) throw unsupported();
    const entries = pdfDictionary(object.value);
    const isAdmittedLink = admittedLink instanceof Set
      ? [...admittedLink].some((candidate) => sameReference(reference, candidate))
      : admittedLink && sameReference(reference, admittedLink);
    if (entries.get('Type')?.type !== 'name' || entries.get('Type').value !== 'Annot'
      || (!isAdmittedLink && (entries.get('Subtype')?.type !== 'name'
        || !PASSIVE_ANNOTATION_SUBTYPES.has(entries.get('Subtype').value)))
      || [...ANNOTATION_REJECTED].some((key) => entries.has(key) && !(isAdmittedLink && key === 'Dest'))) throw unsupported();
  }
  return Object.freeze({ references: Object.freeze(references), reference: value?.type === 'ref' ? pdfReference(value) : null });
}

function collectPages(structure, admittedLink = null) {
  try {
    const catalog = resolvePdfObject(structure, structure.root);
    if (catalog.stream) throw unsupported();
    const catalogEntries = pdfDictionary(catalog.value);
    if ([...CATALOG_REJECTED].some((key) => catalogEntries.has(key))) throw unsupported();
    rejectUnsafeObjects(structure);
    const pagesReference = pdfReference(catalogEntries.get('Pages')); const pages = []; const seen = new Set();
    function visit(reference, parent, depth) {
      if (depth > MAX_PAGE_TREE_DEPTH || seen.size >= MAX_PAGE_TREE_NODES) throw unsupported();
      if (seen.has(referenceText(reference))) throw unsupported(); seen.add(referenceText(reference));
      const object = resolvePdfObject(structure, reference);
      if (object.stream) throw unsupported();
      const entries = pdfDictionary(object.value); const type = entries.get('Type');
      if (type?.type !== 'name' || !['Page', 'Pages'].includes(type.value)) throw unsupported();
      if (parent === null ? entries.has('Parent') : !sameReference(pdfReference(entries.get('Parent')), parent)) throw unsupported();
      if (type.value === 'Page') {
        if ([...PAGE_REJECTED].some((key) => entries.has(key))) throw unsupported();
        const mediaBox = directBox(entries.get('MediaBox')); const cropBox = directBox(entries.get('CropBox'));
        if (mediaBox[0] > cropBox[0] || mediaBox[1] > cropBox[1] || mediaBox[2] < cropBox[2] || mediaBox[3] < cropBox[3]) throw unsupported();
        pages.push(Object.freeze({ reference, entries, cropBox, annotations: entries.has('Annots') ? safeAnnotations(structure, entries.get('Annots'), admittedLink) : Object.freeze({ references: Object.freeze([]), reference: null }) }));
        if (pages.length > MAX_PAGES) throw unsupported(); return 1;
      }
      const kids = entries.get('Kids'); if (kids?.type !== 'array' || kids.values.length === 0) throw unsupported();
      let count = 0; for (const kid of kids.values) count += visit(pdfReference(kid), reference, depth + 1);
      if (pdfInteger(entries.get('Count')) !== count) throw unsupported(); return count;
    }
    visit(pagesReference, null, 0); return Object.freeze(pages);
  } catch (error) { if (error?.code === 'UNSUPPORTED_INCREMENTAL_GOTO_LINK_PDF') throw error; throw unsupported(); }
}

function batchTarget(structure, request) {
  const pages = collectPages(structure);
  const links = request.links.map((link, requestIndex) => {
    const source = pages[link.sourcePage - 1]; const destination = pages[link.targetPage - 1];
    if (!source || !destination || !contains(source.cropBox, link.rect)) throw unsupported();
    return Object.freeze({ ...link, source, destination, requestIndex });
  });
  const grouped = new Map();
  for (const link of links) {
    const group = grouped.get(link.source.reference.object) ?? [];
    group.push(link); grouped.set(link.source.reference.object, group);
  }
  for (const page of grouped.values()) {
    if (page[0].source.annotations.references.length + page.length > MAX_ANNOTATIONS) throw unsupported();
  }
  return Object.freeze({ pages, links, grouped });
}

function target(structure, request, admittedLink = null) {
  const pages = collectPages(structure, admittedLink); const source = pages[request.sourcePage - 1]; const destination = pages[request.targetPage - 1];
  if (!source || !destination || !contains(source.cropBox, request.rect)) throw unsupported();
  return Object.freeze({ pages, source, destination });
}

function annotationValue(targetValue, request) {
  const { left, bottom, right, top } = request.rect;
  return pdfDict([
    ['Type', pdfName('Annot')], ['Subtype', pdfName('Link')],
    ['Rect', pdfArray([pdfNumber(left), pdfNumber(bottom), pdfNumber(right), pdfNumber(top)])],
    ['Border', pdfArray([pdfNumber(0), pdfNumber(0), pdfNumber(0)])],
    ['Dest', pdfArray([targetValue.destination.reference, pdfName('Fit')])],
  ]);
}

function changedId(source, request) {
  return createHash('sha256').update('Platen incremental GoTo link ID v1\0', 'utf8')
    .update(createHash('sha256').update(source).digest()).update(JSON.stringify(request), 'utf8').digest().subarray(0, 16);
}

function canonicalAppend(sourceBytes, structure, targetValue, request) {
  try {
    const link = annotationValue(targetValue, request); const annotationReference = { type: 'ref', object: structure.finalSize, generation: 0 };
    const values = [...targetValue.source.annotations.references, annotationReference];
    const updates = targetValue.source.annotations.reference
      ? [{ reference: targetValue.source.annotations.reference, value: pdfArray(values) }]
      : [{ reference: targetValue.source.reference, value: pdfDict(new Map([...targetValue.source.entries, ['Annots', pdfArray(values)]])) }];
    const transaction = planPdfObjectTransaction({ sourceBytes, sourceStructure: structure, updates, additions: [{ id: 'link', value: link }], info: { kind: 'preserve' }, changingId: structure.id ? changedId(sourceBytes, request) : null });
    if (!sameReference(transaction.referencesById.link, annotationReference)) throw unsupported();
    return Object.freeze({ revision: transaction.revision, bytes: transaction.revision.bytes, annotationReference, updatedReference: updates[0].reference, xrefOffset: transaction.revision.xrefOffset, offsets: Object.freeze(transaction.revision.records.map(({ offset }) => offset)) });
  } catch { throw unsupported(); }
}

function proof(source, output, append, targetValue, request, idPolicy) {
  return Object.freeze({ profile: INCREMENTAL_GOTO_LINK_PROFILE, sourceBytes: source.length, outputBytes: output.buffer.length, appendedBytes: append.bytes.length, sourcePrefixPreserved: true, revisionCount: output.revisions.length, previousXrefOffset: output.revisions[1].offset, appendedXrefOffset: append.xrefOffset, sourcePage: request.sourcePage, targetPage: request.targetPage, rect: request.rect, sourcePageObjectNumber: targetValue.source.reference.object, targetPageObjectNumber: targetValue.destination.reference.object, linkAnnotationObjectNumber: append.annotationReference.object, annotationCount: targetValue.source.annotations.references.length + 1, effectiveSize: output.finalSize, rootPreserved: true, infoPreserved: true, idPolicy });
}

function inspectWithSource(sourceBytes, outputBytes, request, source, targetValue) {
  try {
    if (!Buffer.isBuffer(outputBytes) || (typeof SharedArrayBuffer !== 'undefined' && outputBytes.buffer instanceof SharedArrayBuffer)
      || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const append = canonicalAppend(sourceBytes, source, targetValue, request);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: source, expectedRevision: append.revision }).outputStructure;
    const outputTarget = target(output, request, append.annotationReference);
    if (output.revisions.length !== source.revisions.length + 1 || output.revisions[0].entries.length !== 2 || output.revisions[0].offset !== append.xrefOffset || pdfInteger(output.revisions[0].trailer.get('Prev')) !== source.revisions[0].offset || output.finalSize !== source.finalSize + 1 || !sameReference(output.root, source.root) || (source.info === null) !== (output.info === null) || (source.info && !sameReference(source.info, output.info))) throw invalidOutput();
    const updated = new Set([append.updatedReference.object, append.annotationReference.object]);
    output.revisions[0].entries.forEach((entry, index) => { if (entry.object !== [append.updatedReference, append.annotationReference][index].object || entry.generation !== [append.updatedReference, append.annotationReference][index].generation || entry.offset !== append.offsets[index] || entry.status !== 'n') throw invalidOutput(); });
    for (const [number, entry] of source.effective) { const next = output.effective.get(number); if (!next || (!updated.has(number) && (next.generation !== entry.generation || next.status !== entry.status || (entry.status === 'c' ? next.objectStream !== entry.objectStream || next.index !== entry.index : next.offset !== entry.offset)))) throw invalidOutput(); }
    const link = pdfDictionary(resolvePdfObject(output, append.annotationReference).value); const destination = link.get('Dest');
    if (link.get('Type')?.value !== 'Annot' || link.get('Subtype')?.value !== 'Link' || destination?.type !== 'array' || destination.values.length !== 2 || !sameReference(pdfReference(destination.values[0]), targetValue.destination.reference) || destination.values[1]?.type !== 'name' || destination.values[1].value !== 'Fit' || outputTarget.source.annotations.references.length !== targetValue.source.annotations.references.length + 1 || !sameReference(outputTarget.source.annotations.references.at(-1), append.annotationReference)) throw invalidOutput();
    const idPolicy = source.id ? 'permanent-preserved-changing-updated' : 'absent';
    if ((source.id === null) !== (output.id === null) || (source.id && (!output.id[0].equals(source.id[0]) || !output.id[1].equals(changedId(sourceBytes, request))))) throw invalidOutput();
    return proof(sourceBytes, output, append, targetValue, request, idPolicy);
  } catch (error) { if (error?.code === 'INVALID_INCREMENTAL_GOTO_LINK_OUTPUT') throw error; throw invalidOutput(); }
}

export function inspectIncrementalPdfGoToLink(sourceBytes, outputBytes, requestValue) {
  const request = normalizeIncrementalGoToLink(requestValue); const source = parseSource(sourceBytes);
  return inspectWithSource(sourceBytes, outputBytes, request, source, target(source, request));
}

export function writeIncrementalPdfGoToLink(sourceBytes, requestValue) {
  const request = normalizeIncrementalGoToLink(requestValue); const source = parseSource(sourceBytes);
  const rowCount = source.revisions.reduce((total, revision) => total + revision.entries.length, 0);
  if (source.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions || rowCount + 2 > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported();
  const targetValue = target(source, request); const append = canonicalAppend(sourceBytes, source, targetValue, request); const bytes = Buffer.concat([sourceBytes, append.bytes]);
  return Object.freeze({ bytes, proof: inspectWithSource(sourceBytes, bytes, request, source, targetValue) });
}

function batchAnnotationValue(targetValue, link) {
  const { left, bottom, right, top } = link.rect;
  return pdfDict([
    ['Type', pdfName('Annot')], ['Subtype', pdfName('Link')],
    ['Rect', pdfArray([pdfNumber(left), pdfNumber(bottom), pdfNumber(right), pdfNumber(top)])],
    ['Border', pdfArray([pdfNumber(0), pdfNumber(0), pdfNumber(0)])],
    ['Dest', pdfArray([link.destination.reference, pdfName('Fit')])],
  ]);
}

function batchCanonicalAppend(sourceBytes, structure, targetValue, request) {
  try {
    const additions = targetValue.links.map((link, index) => ({
      id: `link-${index}`,
      value: batchAnnotationValue(targetValue, link),
    }));
    const updates = [...targetValue.grouped.values()].map((links) => {
      const source = links[0].source;
      const values = [...source.annotations.references, ...links.map((link) => ({ type: 'ref', object: structure.finalSize + link.requestIndex, generation: 0 }))];
      const value = source.annotations.reference
        ? pdfArray(values)
        : pdfDict(new Map([...source.entries, ['Annots', pdfArray(values)]]));
      return { reference: source.annotations.reference ?? source.reference, value };
    });
    const transaction = planPdfObjectTransaction({ sourceBytes, sourceStructure: structure, updates, additions, info: { kind: 'preserve' }, changingId: structure.id ? changedId(sourceBytes, request) : null });
    const annotationReferences = additions.map((addition) => transaction.referencesById[addition.id]);
    return Object.freeze({ revision: transaction.revision, bytes: transaction.revision.bytes, updates: Object.freeze(updates.map((update) => update.reference)), pageReferences: Object.freeze([...targetValue.grouped.values()].map((links) => links[0].source.reference)), annotationReferences, xrefOffset: transaction.revision.xrefOffset, offsets: Object.freeze(transaction.revision.records.map(({ offset }) => offset)) });
  } catch { throw unsupported(); }
}

function batchProof(source, output, append, targetValue, request, idPolicy) {
  return Object.freeze({
    profile: INCREMENTAL_BATCH_LINK_PROFILE,
    sourceBytes: source.length,
    outputBytes: output.buffer.length,
    appendedBytes: append.bytes.length,
    sourcePrefixPreserved: true,
    revisionCount: output.revisions.length,
    previousXrefOffset: output.revisions[1].offset,
    appendedXrefOffset: append.xrefOffset,
    links: Object.freeze(targetValue.links.map((link, index) => Object.freeze({
      sourcePage: link.sourcePage, targetPage: link.targetPage, rect: link.rect,
      sourcePageObjectNumber: link.source.reference.object,
      targetPageObjectNumber: link.destination.reference.object,
      linkAnnotationObjectNumber: append.annotationReferences[index].object,
    }))),
    updatedPageObjectNumbers: Object.freeze(append.pageReferences.map((reference) => reference.object)),
    updatedObjectNumbers: Object.freeze(append.updates.map((reference) => reference.object)),
    effectiveSize: output.finalSize,
    rootPreserved: true,
    infoPreserved: true,
    idPolicy,
  });
}

function inspectBatchWithSource(sourceBytes, outputBytes, request, source, targetValue) {
  try {
    if (!Buffer.isBuffer(outputBytes) || (typeof SharedArrayBuffer !== 'undefined' && outputBytes.buffer instanceof SharedArrayBuffer)
      || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const append = batchCanonicalAppend(sourceBytes, source, targetValue, request);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: source, expectedRevision: append.revision }).outputStructure;
    const admitted = new Set(append.annotationReferences);
    const outputPages = collectPages(output, admitted);
    if (output.revisions.length !== source.revisions.length + 1 || output.revisions[0].offset !== append.xrefOffset
      || pdfInteger(output.revisions[0].trailer.get('Prev')) !== source.revisions[0].offset || output.finalSize !== source.finalSize + request.links.length
      || !sameReference(output.root, source.root) || (source.info === null) !== (output.info === null) || (source.info && !sameReference(source.info, output.info))) throw invalidOutput();
    const updated = new Set(append.updates.map((reference) => reference.object));
    for (const [number, entry] of source.effective) {
      const next = output.effective.get(number);
      if (!next || (!updated.has(number) && !append.annotationReferences.some((reference) => reference.object === number)
        && (next.generation !== entry.generation || next.status !== entry.status || (entry.status === 'c' ? next.objectStream !== entry.objectStream || next.index !== entry.index : next.offset !== entry.offset)))) throw invalidOutput();
    }
    for (const [index, link] of targetValue.links.entries()) {
      const annotation = pdfDictionary(resolvePdfObject(output, append.annotationReferences[index]).value);
      const destination = annotation.get('Dest');
      if (annotation.get('Type')?.value !== 'Annot' || annotation.get('Subtype')?.value !== 'Link'
        || destination?.type !== 'array' || destination.values.length !== 2
        || !sameReference(pdfReference(destination.values[0]), link.destination.reference)
        || destination.values[1]?.type !== 'name' || destination.values[1].value !== 'Fit') throw invalidOutput();
      if (!outputPages[link.sourcePage - 1]) throw invalidOutput();
    }
    for (const links of targetValue.grouped.values()) {
      const page = outputPages[links[0].sourcePage - 1];
      const expected = links.map((link) => append.annotationReferences[targetValue.links.indexOf(link)]);
      if (!expected.every((reference, index) => sameReference(page.annotations.references.at(-expected.length + index), reference))) throw invalidOutput();
    }
    const idPolicy = source.id ? 'permanent-preserved-changing-updated' : 'absent';
    if ((source.id === null) !== (output.id === null) || (source.id && (!output.id[0].equals(source.id[0]) || !output.id[1].equals(changedId(sourceBytes, request))))) throw invalidOutput();
    return batchProof(sourceBytes, output, append, targetValue, request, idPolicy);
  } catch (error) { if (error?.code === 'INVALID_INCREMENTAL_GOTO_LINK_OUTPUT') throw error; throw invalidOutput(); }
}

export function inspectIncrementalPdfBatchGoToLinks(sourceBytes, outputBytes, requestValue) {
  const request = normalizeIncrementalBatchGoToLinks(requestValue); const source = parseSource(sourceBytes); const targetValue = batchTarget(source, request);
  return inspectBatchWithSource(sourceBytes, outputBytes, request, source, targetValue);
}

export function writeIncrementalPdfBatchGoToLinks(sourceBytes, requestValue) {
  const request = normalizeIncrementalBatchGoToLinks(requestValue); const source = parseSource(sourceBytes);
  const rowCount = source.revisions.reduce((total, revision) => total + revision.entries.length, 0);
  if (source.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions) throw unsupported();
  const targetValue = batchTarget(source, request);
  if (rowCount + request.links.length + targetValue.grouped.size > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported();
  const append = batchCanonicalAppend(sourceBytes, source, targetValue, request); const bytes = Buffer.concat([sourceBytes, append.bytes]);
  return Object.freeze({ bytes, proof: inspectBatchWithSource(sourceBytes, bytes, request, source, targetValue) });
}
