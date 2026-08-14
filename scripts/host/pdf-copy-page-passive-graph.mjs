import { HostError } from './host-error.mjs';
import { readRegularOutput } from './pdf-service-foundation.mjs';
import { pdfDictionary, pdfInteger, pdfReference } from './pdf-classic-syntax.mjs';
import { parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';

const MAX_COPY_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_TREE_DEPTH = 16;
const MAX_PAGE_TREE_NODES = 256;
const MAX_PAGES = 100;
const MAX_REVISIONS = 32;
const CATALOG_KEYS = Object.freeze(['Pages', 'Type']);
const GRAPH_KEYS = new Set([
  'A', 'AA', 'Annots', 'Dest', 'Dests', 'JS', 'Names', 'Next', 'OC', 'OCGs',
  'OCProperties', 'OpenAction', 'Outlines', 'PA', 'PresSteps', 'Trans', 'Dur',
]);
const ACTION_TYPES = new Set([
  'GoTo', 'GoToR', 'GoToE', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide',
  'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript', 'SetOCGState',
  'Rendition', 'Trans', 'GoTo3DView',
]);
const ANNOTATION_SUBTYPES = new Set([
  'Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine',
  'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink',
  'Popup', 'FileAttachment', 'Sound', 'Movie', 'Widget', 'Screen', 'PrinterMark',
  'TrapNet', 'Watermark', '3D', 'Redact', 'RichMedia', 'Projection',
]);

function unsupported(cause) {
  return new HostError(
    'COPY_PAGE_SOURCE_UNSUPPORTED',
    'Copy-page requires a bounded passive PDF without outlines, optional content, annotations, actions, or other catalog-level structures.',
    422,
    { cause },
  );
}

function scanValue(value, counts, depth = 0) {
  if (depth > 20) throw unsupported();
  if (value?.type === 'array') {
    for (const entry of value.values) scanValue(entry, counts, depth + 1);
    return;
  }
  if (value?.type !== 'dict') return;
  const entries = value.entries;
  const type = entries.get('Type');
  const subtype = entries.get('Subtype');
  const action = entries.get('S');
  if (entries.has('Outlines') || type?.type === 'name' && type.value === 'Outlines') {
    counts.outlineCount += 1;
  }
  if (entries.has('OC') || entries.has('OCGs') || entries.has('OCProperties')
    || type?.type === 'name' && ['OCG', 'OCMD'].includes(type.value)) {
    counts.optionalContentCount += 1;
  }
  if (entries.has('Annots') || type?.type === 'name' && type.value === 'Annot'
    || subtype?.type === 'name' && ANNOTATION_SUBTYPES.has(subtype.value)) {
    counts.annotationCount += 1;
  }
  if (entries.has('A') || entries.has('AA') || entries.has('OpenAction')
    || entries.has('Next') || entries.has('JS')
    || type?.type === 'name' && type.value === 'Action'
    || action?.type === 'name' && ACTION_TYPES.has(action.value)) {
    counts.actionCount += 1;
  }
  if ([...entries.keys()].some((key) => GRAPH_KEYS.has(key))) {
    counts.forbiddenNodeCount += 1;
  }
  for (const entry of entries.values()) scanValue(entry, counts, depth + 1);
}

function referenceKey(reference) {
  return `${reference.object}:${reference.generation}`;
}

function sameReference(left, right) {
  return left.object === right.object && left.generation === right.generation;
}

function inspectPageTree(structure, catalogEntries) {
  const seen = new Set();
  let pageCount = 0;
  function visit(reference, parent, depth) {
    if (depth > MAX_PAGE_TREE_DEPTH || seen.size >= MAX_PAGE_TREE_NODES) {
      throw unsupported();
    }
    const key = referenceKey(reference);
    if (seen.has(key)) throw unsupported();
    seen.add(key);
    const object = resolvePdfObject(structure, reference);
    if (object.stream) throw unsupported();
    const entries = pdfDictionary(object.value);
    const type = entries.get('Type');
    if (type?.type !== 'name' || !['Page', 'Pages'].includes(type.value)) {
      throw unsupported();
    }
    if (parent === null ? entries.has('Parent')
      : !sameReference(pdfReference(entries.get('Parent')), parent)) throw unsupported();
    if (type.value === 'Page') {
      pageCount += 1;
      if (pageCount > MAX_PAGES) throw unsupported();
      return 1;
    }
    const kids = entries.get('Kids');
    if (kids?.type !== 'array' || kids.values.length < 1) throw unsupported();
    let descendants = 0;
    for (const kid of kids.values) {
      descendants += visit(pdfReference(kid), reference, depth + 1);
    }
    if (pdfInteger(entries.get('Count')) !== descendants) throw unsupported();
    return descendants;
  }
  const pagesReference = pdfReference(catalogEntries.get('Pages'));
  visit(pagesReference, null, 0);
  return Object.freeze({ pageCount, pageTreeNodeCount: seen.size });
}

export function inspectPassiveCopyGraph(bytes, { expectedPageCount } = {}) {
  try {
    if (!Buffer.isBuffer(bytes)
      || (typeof SharedArrayBuffer !== 'undefined'
        && bytes.buffer instanceof SharedArrayBuffer)) throw unsupported();
    const structure = parsePdfStructure(bytes);
    if (structure.revisions.length < 1 || structure.revisions.length > MAX_REVISIONS
      || !Number.isSafeInteger(expectedPageCount) || expectedPageCount < 1
      || expectedPageCount > MAX_PAGES) throw unsupported();
    const catalog = resolvePdfObject(structure, structure.root);
    const catalogEntries = pdfDictionary(catalog.value);
    if (catalog.stream
      || [...catalogEntries.keys()].sort().join(',') !== CATALOG_KEYS.join(',')
      || catalogEntries.get('Type')?.type !== 'name'
      || catalogEntries.get('Type').value !== 'Catalog') throw unsupported();
    const counts = {
      outlineCount: 0,
      optionalContentCount: 0,
      annotationCount: 0,
      actionCount: 0,
      forbiddenNodeCount: 0,
    };
    const objectCount = visitPdfObjects(structure, (object) => scanValue(object.value, counts));
    if (Object.values(counts).some((count) => count !== 0)) throw unsupported();
    const pageTree = inspectPageTree(structure, catalogEntries);
    if (pageTree.pageCount !== expectedPageCount) throw unsupported();
    return Object.freeze({
      schema: 'pdf-copy-page-passive-graph-v1',
      version: 1,
      pageCount: pageTree.pageCount,
      pageTreeNodeCount: pageTree.pageTreeNodeCount,
      objectCount,
      revisionCount: structure.revisions.length,
      xrefFlavor: structure.xrefFlavor,
      outlinesPresent: false,
      optionalContentPresent: false,
      annotationCount: 0,
      actionCount: 0,
    });
  } catch (error) {
    if (error instanceof HostError && error.code === 'COPY_PAGE_SOURCE_UNSUPPORTED') {
      throw error;
    }
    throw unsupported(error);
  }
}

export async function inspectPassiveCopyGraphFile(filePath, { expectedPageCount, signal } = {}) {
  if (signal?.aborted) throw signal.reason ?? new Error('Copy-page graph inspection was cancelled.');
  const bytes = await readRegularOutput(filePath, {
    minimumBytes: 5,
    maximumBytes: MAX_COPY_SOURCE_BYTES,
    label: 'Copy-page staged source',
  });
  if (signal?.aborted) throw signal.reason ?? new Error('Copy-page graph inspection was cancelled.');
  const result = inspectPassiveCopyGraph(bytes, { expectedPageCount });
  if (signal?.aborted) throw signal.reason ?? new Error('Copy-page graph inspection was cancelled.');
  return result;
}
