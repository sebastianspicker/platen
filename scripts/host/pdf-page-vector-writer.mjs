import {
  pdfDictionary,
  pdfInteger,
  pdfReference,
  serializePdfValue,
} from './pdf-classic-syntax.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject,
} from './pdf-classic-structure.mjs';
import {
  pendingPdfObjectReference,
  planPdfObjectTransaction,
} from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import {
  INCREMENTAL_PAGE_VECTOR_PROFILE,
  normalizeIncrementalPageVector,
} from './pdf-page-vector-contract.mjs';
import { changedId, pageVectorProof, vectorStream } from './pdf-page-vector-proof.mjs';
import { writeIncrementalPdfPageText as writePageText } from './pdf-page-text-writer.mjs';

const MAX_PAGE_TREE_DEPTH = 16;
const MAX_PAGE_TREE_NODES = 256;
const MAX_PAGES = 100;
const CATALOG_REJECTED_KEYS = new Set([
  'AA', 'AcroForm', 'AF', 'Collection', 'Metadata', 'Names', 'OpenAction',
  'Outlines', 'Perms', 'URI', 'Encrypt',
]);
const PAGE_REJECTED_KEYS = new Set([
  'AA', 'A', 'Annots', 'Contents', 'Dur', 'Metadata', 'PresSteps', 'Trans',
  'UserUnit', 'Rotate',
]);
const UNSAFE_OBJECT_KEYS = new Set([
  'A', 'AA', 'Action', 'ByteRange', 'EmbeddedFiles', 'EF', 'FS', 'JS',
  'OpenAction', 'Sig', 'XFA',
]);
const ACTIVE_ACTIONS = new Set([
  'GoTo', 'GoToR', 'GoToE', 'Launch', 'Thread', 'URI', 'Sound', 'Movie',
  'Hide', 'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript',
  'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView',
]);

function invalid(message = 'Incremental page-vector output proof failed.') {
  const error = new Error(message);
  error.code = 'INVALID_INCREMENTAL_PAGE_VECTOR_OUTPUT';
  return error;
}
function unsupported() {
  const error = new Error('PDF is outside the supported bounded incremental page-vector subset.');
  error.code = 'UNSUPPORTED_INCREMENTAL_PAGE_VECTOR_PDF';
  return error;
}
function invalidOutput() {
  const error = new Error('Incremental page-vector output proof failed.');
  error.code = 'INVALID_INCREMENTAL_PAGE_VECTOR_OUTPUT';
  return error;
}
function sameReference(left, right) { return left.object === right.object && left.generation === right.generation; }
function referenceText(reference) { return `${reference.object} ${reference.generation} R`; }
function pdfNumber(value) { return Object.freeze({ type: 'number', value, integer: true, raw: String(value) }); }
function pdfArray(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function pdfDict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }

function checkedSource(sourceBytes) {
  if (!Buffer.isBuffer(sourceBytes)
    || (typeof SharedArrayBuffer !== 'undefined' && sourceBytes.buffer instanceof SharedArrayBuffer)) {
    throw unsupported();
  }
  try { return parsePdfStructure(sourceBytes); } catch { throw unsupported(); }
}

function directIntegerBox(value) {
  if (value?.type !== 'array' || value.values.length !== 4
    || value.values.some((entry) => entry?.type !== 'number' || !entry.integer)) {
    throw unsupported();
  }
  const box = value.values.map((entry) => pdfInteger(entry));
  if (box[0] >= box[2] || box[1] >= box[3]) {
    throw unsupported();
  }
  return Object.freeze(box);
}

function requestedRect(request) {
  const { x, y, width, height } = request.rect;
  return Object.freeze([x, y, x + width, y + height]);
}

function contains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1]
    && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function rejectUnsafeObjectTypes(structure, object) {
  const entries = object.value.entries;
  const type = entries.get('Type');
  const subtype = entries.get('Subtype');
  const fieldType = entries.get('FT');
  const isControl = structure.controlObjectNumbers?.has(object.reference.object)
    && type?.type === 'name'
    && ['ObjStm', 'XRef'].includes(type.value);
  if (isControl) return;
  if ((type?.type === 'name'
    && ['Metadata', 'Sig', 'EmbeddedFile', 'Filespec'].includes(type.value))
    || (subtype?.type === 'name' && subtype.value === 'XML')
    || (fieldType?.type === 'name' && fieldType.value === 'Sig')
    || [...UNSAFE_OBJECT_KEYS].some((key) => entries.has(key))
    || (entries.get('S')?.type === 'name' && ACTIVE_ACTIONS.has(entries.get('S').value))) {
    throw unsupported();
  }
  if (type?.type === 'name' && ['Action', 'Widget', 'EmbeddedFile', 'Filespec'].includes(type.value)) {
    throw unsupported();
  }
}

function rejectUnsafeObjects(structure) {
  visitPdfObjects(structure, (object) => {
    if (object.value?.type !== 'dict') return;
    rejectUnsafeObjectTypes(structure, object);
  });
}

function collectPages(structure) {
  try {
    const catalog = resolvePdfObject(structure, structure.root);
    if (catalog.stream) throw unsupported();
    const catalogEntries = pdfDictionary(catalog.value);
    if (catalogEntries.get('Type')?.type !== 'name'
      || catalogEntries.get('Type').value !== 'Catalog'
      || [...CATALOG_REJECTED_KEYS].some((key) => catalogEntries.has(key))) {
      throw unsupported();
    }

    rejectUnsafeObjects(structure);
    const pagesReference = pdfReference(catalogEntries.get('Pages'));
    const pages = [];
    const seen = new Set();

    function visit(reference, parent, depth) {
      if (depth > MAX_PAGE_TREE_DEPTH || seen.size >= MAX_PAGE_TREE_NODES) throw unsupported();
      const key = referenceText(reference);
      if (seen.has(key)) throw unsupported();
      seen.add(key);

      const object = resolvePdfObject(structure, reference);
      if (object.stream) throw unsupported();
      const entries = pdfDictionary(object.value);
      const type = entries.get('Type');
      if (type?.type !== 'name' || !['Page', 'Pages'].includes(type.value)) throw unsupported();

      if (parent === null) {
        if (entries.has('Parent')) throw unsupported();
      } else if (!sameReference(pdfReference(entries.get('Parent')), parent)) {
        throw unsupported();
      }

      if (type.value === 'Page') {
        if ([...PAGE_REJECTED_KEYS].some((key) => entries.has(key))) throw unsupported();
        const mediaBox = directIntegerBox(entries.get('MediaBox'));
        const cropBox = directIntegerBox(entries.get('CropBox'));
        if (!contains(mediaBox, cropBox)) throw unsupported();
        pages.push(Object.freeze({
          reference,
          entries: Object.freeze(entries),
          mediaBox,
          cropBox,
        }));
        if (pages.length > MAX_PAGES) throw unsupported();
        return 1;
      }

      const kids = entries.get('Kids');
      if (kids?.type !== 'array' || kids.values.length === 0) throw unsupported();
      let total = 0;
      for (const child of kids.values) {
        total += visit(pdfReference(child), reference, depth + 1);
      }
      if (pdfInteger(entries.get('Count')) !== total) throw unsupported();
      return total;
    }

    visit(pagesReference, null, 0);
    return Object.freeze(pages);
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_INCREMENTAL_PAGE_VECTOR_PDF') throw error;
    throw unsupported();
  }
}

function selectedPage(structure, request) {
  const pages = collectPages(structure);
  const page = pages[request.page - 1];
  if (!page) throw unsupported();
  const geometry = requestedRect(request);
  if (!contains(page.mediaBox, geometry) || !contains(page.cropBox, geometry)) throw unsupported();
  return Object.freeze({
    pages,
    page,
    geometry,
    pageObjectText: referenceText(page.reference),
  });
}

function contentReferences(value, addition) {
  if (value === undefined) return Object.freeze([addition]);
  if (value?.type === 'ref') return Object.freeze([pdfReference(value), addition]);
  if (value?.type !== 'array') throw unsupported();
  const values = value.values.map((entry) => pdfReference(entry));
  if (values.length >= 2000 || new Set(values.map(referenceText)).size !== values.length) throw unsupported();
  return Object.freeze([...values, addition]);
}

function expectedPageValue(pageEntries, addition) {
  return pdfDict([
    ...pageEntries,
    ['Contents', pdfArray(contentReferences(pageEntries.get('Contents'), addition))],
  ]);
}

function canonicalAppend(sourceBytes, structure, state, request) {
  try {
    const stream = vectorStream(request);
    const streamRef = pendingPdfObjectReference('vector');
    const pageValue = expectedPageValue(state.page.entries, streamRef);
    const transaction = planPdfObjectTransaction({
      sourceBytes,
      sourceStructure: structure,
      updates: [{
        reference: state.page.reference,
        value: pageValue,
      }],
      additions: [{
        id: 'vector',
        value: pdfDict([['Length', pdfNumber(stream.length)]]),
        streamBytes: stream,
      }],
      info: { kind: 'preserve' },
      changingId: structure.id ? changedId(sourceBytes, request) : null,
    });
    const revision = transaction.revision;
    const streamReference = transaction.referencesById.vector;

    const streamRecord = revision.records.find((record) => sameReference(record.reference, streamReference));
    const pageRecord = revision.records.find((record) => sameReference(record.reference, state.page.reference));
    if (!streamReference || !streamRecord || !pageRecord) throw unsupported();

    return Object.freeze({
      revision,
      bytes: revision.bytes,
      stream,
      streamReference,
      streamOffset: streamRecord.offset,
      streamRecord,
      pageRecord,
    });
  } catch {
    throw unsupported();
  }
}

function normalizeContents(value) {
  if (value?.type === 'ref') return Object.freeze([pdfReference(value)]);
  if (value?.type === 'array') return Object.freeze(value.values.map((entry) => pdfReference(entry)));
  return Object.freeze([]);
}

function inspectWithSource(sourceBytes, outputBytes, request, source, state) {
  try {
    if (!Buffer.isBuffer(outputBytes)
      || (typeof SharedArrayBuffer !== 'undefined' && outputBytes.buffer instanceof SharedArrayBuffer)
      || outputBytes.length <= sourceBytes.length
      || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) {
      throw invalidOutput();
    }

    const append = canonicalAppend(sourceBytes, source, state, request);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) {
      throw invalidOutput();
    }

    const output = verifyPdfIncrementalRevision({
      sourceBytes,
      outputBytes,
      sourceStructure: source,
      expectedRevision: append.revision,
    }).outputStructure;

    const outputRevision = output.revisions[0];
    if (output.revisions.length !== source.revisions.length + 1
      || output.finalSize !== source.finalSize + 1
      || outputRevision.offset !== append.revision.xrefOffset
      || !sameReference(output.root, source.root)
      || (source.info === null) !== (output.info === null)
      || (output.info && !sameReference(source.info, output.info))) {
      throw invalidOutput();
    }

    const prev = outputRevision.entries.find((entry) => sameReference(entry, source.root));
    void prev;
    if (outputRevision.entries.length !== 2) throw invalidOutput();
    const pageEntry = outputRevision.entries.find((entry) => sameReference(entry, state.page.reference));
    const streamEntry = outputRevision.entries.find((entry) => sameReference(entry, append.streamReference));
    if (!pageEntry || !streamEntry
      || pageEntry.offset !== append.pageRecord.offset
      || streamEntry.offset !== append.streamRecord.offset
      || pageEntry.status !== 'n' || streamEntry.status !== 'n') {
      throw invalidOutput();
    }

    const sourceEntries = source.effective;
    for (const [number, entry] of sourceEntries) {
      if (number === state.page.reference.object || number === append.streamReference.object) continue;
      const next = output.effective.get(number);
      if (!next || next.status !== entry.status || next.generation !== entry.generation
        || (entry.status === 'c'
          ? (next.objectStream !== entry.objectStream || next.index !== entry.index)
          : next.offset !== entry.offset)) {
        throw invalidOutput();
      }
    }

    const sourceContents = normalizeContents(state.page.entries.get('Contents'));
    const outputPage = resolvePdfObject(output, state.page.reference);
    const outputPageEntries = pdfDictionary(outputPage.value);
    if (outputPage.value.type !== 'dict' || outputPageEntries.get('Type')?.value !== 'Page') {
      throw invalidOutput();
    }
    const outputContents = normalizeContents(outputPageEntries.get('Contents'));
    if (outputContents.length !== sourceContents.length + 1
      || !sameReference(outputContents.at(-1), append.streamReference)) {
      throw invalidOutput();
    }
    for (let index = 0; index < sourceContents.length; index += 1) {
      if (!sameReference(sourceContents[index], outputContents[index])) {
        throw invalidOutput();
      }
    }

    const sourceWithoutContents = new Map(state.page.entries);
    const outputWithoutContents = new Map(outputPageEntries);
    sourceWithoutContents.delete('Contents');
    outputWithoutContents.delete('Contents');
    if (serializePdfValue({ type: 'dict', entries: sourceWithoutContents })
      !== serializePdfValue({ type: 'dict', entries: outputWithoutContents })) {
      throw invalidOutput();
    }

    const streamObject = resolvePdfObject(output, append.streamReference);
    if (!streamObject.stream
      || streamObject.streamLength !== append.stream.length
      || !outputBytes.subarray(streamObject.streamStart, streamObject.streamStart + append.stream.length).equals(append.stream)) {
      throw invalidOutput();
    }

    const idPolicy = source.id ? 'permanent-preserved-changing-updated' : 'absent';
    if ((source.id === null) !== (output.id === null)
      || (source.id
        && (!output.id[0].equals(source.id[0])
          || !output.id[1].equals(changedId(sourceBytes, request))))) {
      throw invalidOutput();
    }

  return pageVectorProof(sourceBytes, output, append, request, state, idPolicy);
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_PAGE_VECTOR_OUTPUT') throw error;
    throw invalidOutput();
  }
}

export function inspectIncrementalPdfPageVector(sourceBytes, outputBytes, requestValue) {
  const request = normalizeIncrementalPageVector(requestValue);
  const source = checkedSource(sourceBytes);
  const state = selectedPage(source, request);
  return inspectWithSource(sourceBytes, outputBytes, request, source, state);
}

export function writeIncrementalPdfPageVector(sourceBytes, requestValue) {
  const request = normalizeIncrementalPageVector(requestValue);
  const source = checkedSource(sourceBytes);
  const state = selectedPage(source, request);
  const entries = source.revisions.reduce((total, revision) => total + revision.entries.length, 0);
  if (source.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions
    || entries + 2 > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) {
    throw unsupported();
  }
  const append = canonicalAppend(sourceBytes, source, state, request);
  const bytes = Buffer.concat([sourceBytes, append.bytes]);
  return Object.freeze({ bytes, proof: inspectWithSource(sourceBytes, bytes, request, source, state) });
}

export function writeIncrementalPdfPageText(sourceBytes, requestValue) {
  return writePageText({ sourceBytes, requestValue, checkedSource, selectedPage, pdfDict, pdfArray, pdfNumber, changedId, unsupported });
}
