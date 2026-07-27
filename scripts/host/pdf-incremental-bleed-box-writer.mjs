import { createHash } from 'node:crypto';
import {
  pdfDictionary, pdfInteger, pdfReference, serializePdfValue,
} from './pdf-classic-syntax.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject,
} from './pdf-classic-structure.mjs';
import {
  planPdfObjectTransaction,
} from './pdf-classic-object-transaction.mjs';
import {
  verifyPdfIncrementalRevision,
} from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import {
  INCREMENTAL_BLEED_BOX_PROFILE, normalizeIncrementalBleedBox,
} from './pdf-incremental-bleed-box-contract.mjs';

const MAX_PAGE_TREE_DEPTH = 16;
const MAX_PAGE_TREE_NODES = 256;
const ACTION_KEYS = new Set(['A', 'AA', 'OpenAction']);
const CATALOG_REJECTED_KEYS = new Set([
  'AA', 'AcroForm', 'AF', 'Collection', 'Metadata', 'Names', 'OpenAction', 'Outlines', 'URI',
]);
const PAGE_REJECTED_KEYS = new Set(['AA', 'A', 'Annots', 'Dur', 'Metadata', 'PresSteps', 'Trans']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported() { return failure('UNSUPPORTED_INCREMENTAL_BLEED_BOX_PDF', 'PDF is outside the supported bounded incremental bleed-box subset.'); }
function invalidOutput() { return failure('INVALID_INCREMENTAL_BLEED_BOX_OUTPUT', 'Incremental bleed-box output proof failed.'); }
function noChange() { return failure('INVALID_INCREMENTAL_BLEED_BOX', 'Incremental PDF bleed box would not change the selected page.'); }
function sameReference(left, right) { return left.object === right.object && left.generation === right.generation; }
function refText(ref) { return `${ref.object} ${ref.generation} R`; }

function parseStructure(buffer) {
  try { return parsePdfStructure(buffer); } catch { throw unsupported(); }
}

function directBox(value) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry?.type !== 'number'
    || !Number.isFinite(entry.value))) throw unsupported();
  const values = value.values.map((entry) => entry.value);
  if (values[0] >= values[2] || values[1] >= values[3]) throw unsupported();
  return Object.freeze(values);
}

function rectangleBox(request) {
  const { x, y, width, height } = request.rect;
  return Object.freeze([x, y, x + width, y + height]);
}

function contains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function equalBox(left, right) { return left.every((value, index) => value === right[index]); }

function rejectActions(entries) {
  if ([...ACTION_KEYS].some((key) => entries.has(key))) throw unsupported();
}

function rejectUnsafeObjectTypes(structure) {
  visitPdfObjects(structure, (object) => {
    if (object.value?.type !== 'dict') return;
    const type = object.value.entries.get('Type');
    const subtype = object.value.entries.get('Subtype');
    const fieldType = object.value.entries.get('FT');
    if ((type?.type === 'name' && (['Metadata', 'Sig'].includes(type.value)
      || (['ObjStm', 'XRef'].includes(type.value)
        && !structure.controlObjectNumbers?.has(object.reference.object))))
      || (subtype?.type === 'name' && subtype.value === 'XML')
      || (fieldType?.type === 'name' && fieldType.value === 'Sig')) throw unsupported();
  });
}

function collectPages(structure) {
  try {
    const catalog = resolvePdfObject(structure, structure.root);
    if (catalog.stream) throw unsupported();
    const catalogEntries = pdfDictionary(catalog.value);
    if ([...CATALOG_REJECTED_KEYS].some((key) => catalogEntries.has(key))) throw unsupported();
    rejectUnsafeObjectTypes(structure);
    const pagesReference = pdfReference(catalogEntries.get('Pages'));
    const seen = new Set(); const pages = [];
    function visit(reference, parent, depth) {
      if (depth > MAX_PAGE_TREE_DEPTH || seen.size >= MAX_PAGE_TREE_NODES) throw unsupported();
      const key = refText(reference); if (seen.has(key)) throw unsupported(); seen.add(key);
      const object = resolvePdfObject(structure, reference);
      if (object.stream) throw unsupported();
      const entries = pdfDictionary(object.value); const type = entries.get('Type');
      if (type?.type !== 'name' || !['Pages', 'Page'].includes(type.value)) throw unsupported();
      rejectActions(entries);
      if (parent === null && entries.has('Parent')) throw unsupported();
      if (parent !== null) {
        const declaredParent = pdfReference(entries.get('Parent'));
        const parentObject = resolvePdfObject(structure, declaredParent);
        if (parentObject.stream || pdfDictionary(parentObject.value).get('Type')?.value !== 'Pages'
          || !sameReference(declaredParent, parent)) throw unsupported();
      }
      if (type.value === 'Page') {
        if ([...PAGE_REJECTED_KEYS].some((key) => entries.has(key))) throw unsupported();
        pages.push(Object.freeze({ reference, object, entries }));
        if (pages.length > 100) throw unsupported();
        return 1;
      }
      const kids = entries.get('Kids');
      if (kids?.type !== 'array' || kids.values.length === 0) throw unsupported();
      let count = 0;
      for (const kid of kids.values) count += visit(pdfReference(kid), reference, depth + 1);
      if (pdfInteger(entries.get('Count')) !== count) throw unsupported();
      return count;
    }
    visit(pagesReference, null, 0);
    return Object.freeze(pages);
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_INCREMENTAL_BLEED_BOX_PDF') throw error;
    throw unsupported();
  }
}

function selectedPage(structure, request, allowNoop = false) {
  const pages = collectPages(structure); const selected = pages[request.page - 1];
  if (!selected) throw unsupported();
  const media = directBox(selected.entries.get('MediaBox'));
  const trim = directBox(selected.entries.get('TrimBox'));
  const bleed = directBox(selected.entries.get('BleedBox'));
  const requested = rectangleBox(request);
  if (!contains(media, trim) || !contains(media, bleed) || !contains(bleed, trim)
    || !contains(media, requested) || !contains(requested, trim)) throw unsupported();
  if (!allowNoop && equalBox(bleed, requested)) throw noChange();
  return Object.freeze({ pages, selected, media, trim, bleed, requested });
}

function changedId(source, request) {
  const digest = createHash('sha256').update(source).digest();
  return createHash('sha256').update('Platen incremental bleed box ID v1\0', 'utf8')
    .update(digest).update(JSON.stringify(request), 'utf8').digest().subarray(0, 16);
}

function expectedPage(entries, requested) {
  const changed = new Map(entries);
  changed.set('BleedBox', Object.freeze({ type: 'array', values: Object.freeze(requested.map((value) => Object.freeze({
    type: 'number', value, integer: true, raw: String(value),
  }))) }));
  return Object.freeze({ type: 'dict', entries: changed });
}

function canonicalAppend(source, structure, target, request) {
  try {
    const revision = planPdfObjectTransaction({
      sourceBytes: source,
      sourceStructure: structure,
      updates: [{
        reference: target.selected.reference,
        value: expectedPage(target.selected.entries, target.requested),
      }],
      additions: [],
      info: { kind: 'preserve' },
      changingId: structure.id ? changedId(source, request) : null,
    }).revision;
    return Object.freeze({
      revision,
      bytes: revision.bytes,
      objectOffset: revision.records[0].offset,
      xrefOffset: revision.xrefOffset,
    });
  } catch {
    throw unsupported();
  }
}

function withoutBleed(entries) {
  const copy = new Map(entries); copy.delete('BleedBox'); return serializePdfValue({ type: 'dict', entries: copy });
}

function proof(source, output, append, target, request, idPolicy) {
  return Object.freeze({
    profile: INCREMENTAL_BLEED_BOX_PROFILE, sourceBytes: source.length, outputBytes: output.buffer.length,
    appendedBytes: append.bytes.length, sourcePrefixPreserved: true, onlyTargetChanged: true,
    revisionCount: output.revisions.length, sourceRevisionCount: output.revisions.length - 1,
    previousXrefOffset: output.revisions[1].offset, appendedXrefOffset: append.xrefOffset,
    page: request.page, pageObjectNumber: target.selected.reference.object,
    pageGeneration: target.selected.reference.generation, pageReference: refText(target.selected.reference),
    rect: request.rect, effectiveSize: output.finalSize, rootPreserved: true,
    infoPreserved: true, idPolicy,
  });
}

function inspectWithSource(sourceBytes, outputBytes, request, source, target) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length
      || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const append = canonicalAppend(sourceBytes, source, target, request);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({
      sourceBytes,
      outputBytes,
      sourceStructure: source,
      expectedRevision: append.revision,
    }).outputStructure;
    const outputTarget = selectedPage(output, request, true);
    if (output.revisions.length !== source.revisions.length + 1 || output.revisions[0].entries.length !== 1
      || output.revisions[0].offset !== append.xrefOffset || pdfInteger(output.revisions[0].trailer.get('Prev')) !== source.revisions[0].offset
      || output.finalSize !== source.finalSize || !sameReference(output.root, source.root)
      || (source.info === null) !== (output.info === null) || (source.info && !sameReference(output.info, source.info))) throw invalidOutput();
    if (output.revisions[0].entries[0].object !== target.selected.reference.object
      || output.revisions[0].entries[0].generation !== target.selected.reference.generation
      || output.revisions[0].entries[0].offset !== append.objectOffset) throw invalidOutput();
    for (const [number, entry] of source.effective) {
      const next = output.effective.get(number);
      if (!next || (number !== target.selected.reference.object && (
        next.generation !== entry.generation || next.status !== entry.status
        || (entry.status === 'c'
          ? next.objectStream !== entry.objectStream || next.index !== entry.index
          : next.offset !== entry.offset)
      ))) throw invalidOutput();
    }
    if (output.effective.size !== source.effective.size || !equalBox(outputTarget.bleed, target.requested)
      || outputTarget.pages.length !== target.pages.length
      || outputTarget.pages.some((page, index) => !sameReference(page.reference, target.pages[index].reference))
      || withoutBleed(outputTarget.selected.entries) !== withoutBleed(target.selected.entries)) throw invalidOutput();
    const idPolicy = source.id ? 'permanent-preserved-changing-updated' : 'absent';
    if ((source.id === null) !== (output.id === null) || (source.id && (!output.id[0].equals(source.id[0])
      || !output.id[1].equals(changedId(sourceBytes, request))))) throw invalidOutput();
    return proof(sourceBytes, output, append, target, request, idPolicy);
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_BLEED_BOX') throw error;
    throw invalidOutput();
  }
}

export function inspectIncrementalPdfBleedBox(sourceBytes, outputBytes, requestValue) {
  const request = normalizeIncrementalBleedBox(requestValue); const source = parseStructure(sourceBytes);
  return inspectWithSource(sourceBytes, outputBytes, request, source, selectedPage(source, request));
}

export function writeIncrementalPdfBleedBox(sourceBytes, requestValue) {
  const request = normalizeIncrementalBleedBox(requestValue); const source = parseStructure(sourceBytes);
  const entryCount = source.revisions.reduce((sum, revision) => sum + revision.entries.length, 0);
  if (source.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions
    || entryCount >= CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported();
  const target = selectedPage(source, request); const append = canonicalAppend(sourceBytes, source, target, request);
  const bytes = Buffer.concat([sourceBytes, append.bytes]);
  return Object.freeze({ bytes, proof: inspectWithSource(sourceBytes, bytes, request, source, target) });
}
