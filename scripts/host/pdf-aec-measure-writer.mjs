import { createHash } from 'node:crypto';
import {
  pdfDictionary,
  pdfInteger,
  pdfReference,
  serializePdfValue,
} from './pdf-classic-syntax.mjs';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS,
  parsePdfStructure,
  resolvePdfObject,
} from './pdf-classic-structure.mjs';
import {
  pendingPdfObjectReference,
  planPdfObjectTransaction,
} from './pdf-classic-object-transaction.mjs';
import {
  verifyPdfIncrementalRevision,
} from './pdf-classic-incremental-revision.mjs';
import { normalizeAecMeasureDictionaryInput } from './pdf-aec-measure-contract.mjs';

export const AEC_MEASURE_DICTIONARY_PROFILE = 'platen-aec-measure-dictionary-v1';

const MAX_PAGE_TREE_DEPTH = 16;
const MAX_PAGE_TREE_NODES = 256;
const MAX_PAGES = 100;
const MAX_ANNOTATIONS = 50;
const ACTIVE_ANNOTATION_KEYS = new Set([
  'A', 'AA', 'FS', 'Measure', 'Movie', 'Parent', 'Popup', 'RichMediaContent', 'Sound', '3DD',
]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unsupported() {
  return failure(
    'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF',
    'PDF is outside the supported bounded AEC measure-dictionary subset.',
  );
}

function invalidOutput() {
  return failure(
    'INVALID_AEC_MEASURE_DICTIONARY_OUTPUT',
    'The incremental AEC measure-dictionary output proof failed.',
  );
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000;
}

function closeEnough(left, right) {
  return Math.abs(left - right) <= Math.max(0.000001, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
}

function decimal(value) {
  if (!finite(value)) throw unsupported();
  const source = Object.is(value, -0) ? '0' : String(value);
  if (!/[eE]/u.test(source)) return source;
  const sign = source.startsWith('-') ? '-' : '';
  const unsigned = sign ? source.slice(1) : source;
  const [coefficient, exponentText] = unsigned.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const dot = coefficient.indexOf('.');
  const digits = coefficient.replace('.', '');
  const decimalIndex = (dot === -1 ? coefficient.length : dot) + exponent;
  let expanded;
  if (decimalIndex <= 0) expanded = `0.${'0'.repeat(-decimalIndex)}${digits}`;
  else if (decimalIndex >= digits.length) expanded = `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  else expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  const result = `${sign}${expanded}`;
  if (Number(result) !== value) throw unsupported();
  return result;
}

function pdfNumber(value) {
  return Object.freeze({ type: 'number', value, integer: Number.isInteger(value), raw: decimal(value) });
}

function pdfName(value) { return Object.freeze({ type: 'name', value }); }
function pdfText(value) { return Object.freeze({ type: 'string', bytes: Buffer.from(value, 'ascii') }); }
function pdfArray(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function pdfDict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function reference(object, generation = 0) { return Object.freeze({ type: 'ref', object, generation }); }
function sameReference(left, right) { return left.object === right.object && left.generation === right.generation; }
function referenceText(value) { return `${value.object} ${value.generation} R`; }

function parseSource(buffer) {
  try { return parsePdfStructure(buffer); } catch { throw unsupported(); }
}

function collectPages(structure) {
  try {
    const catalog = resolvePdfObject(structure, structure.root);
    const catalogEntries = pdfDictionary(catalog.value);
    const pagesReference = pdfReference(catalogEntries.get('Pages'));
    const pages = []; const seen = new Set();
    function visit(pageReference, parent, depth) {
      if (depth > MAX_PAGE_TREE_DEPTH || seen.size >= MAX_PAGE_TREE_NODES) throw unsupported();
      const key = referenceText(pageReference);
      if (seen.has(key)) throw unsupported();
      seen.add(key);
      const object = resolvePdfObject(structure, pageReference);
      if (object.stream) throw unsupported();
      const entries = pdfDictionary(object.value);
      const type = entries.get('Type');
      if (type?.type !== 'name' || !['Page', 'Pages'].includes(type.value)) throw unsupported();
      if (parent === null) {
        if (entries.has('Parent')) throw unsupported();
      } else if (!sameReference(pdfReference(entries.get('Parent')), parent)) throw unsupported();
      if (type.value === 'Page') {
        pages.push(Object.freeze({ reference: pageReference, entries }));
        if (pages.length > MAX_PAGES) throw unsupported();
        return 1;
      }
      const kids = entries.get('Kids');
      if (kids?.type !== 'array' || kids.values.length < 1) throw unsupported();
      let count = 0;
      for (const kid of kids.values) count += visit(pdfReference(kid), pageReference, depth + 1);
      if (pdfInteger(entries.get('Count')) !== count) throw unsupported();
      return count;
    }
    visit(pagesReference, null, 0);
    return Object.freeze({ catalogEntries, pages });
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_AEC_MEASURE_DICTIONARY_PDF') throw error;
    throw unsupported();
  }
}

function resolvedArray(structure, value) {
  const resolved = value?.type === 'ref' ? resolvePdfObject(structure, pdfReference(value)) : { value, stream: false };
  if (resolved.stream || resolved.value?.type !== 'array') throw unsupported();
  return resolved.value;
}

function numericArray(value, expectedLength) {
  if (value?.type !== 'array' || value.values.length !== expectedLength
    || value.values.some((entry) => entry?.type !== 'number' || !finite(entry.value))) throw unsupported();
  return value.values.map((entry) => entry.value);
}

function samePoints(values, expected) {
  return values.length === expected.length * 2 && expected.every(
    (value, index) => closeEnough(values[index * 2], value.x) && closeEnough(values[index * 2 + 1], value.y),
  );
}

function targetAnnotation(structure, pageEntries, input) {
  const annotations = resolvedArray(structure, pageEntries.get('Annots'));
  if (annotations.values.length < 1 || annotations.values.length > MAX_ANNOTATIONS) throw unsupported();
  const annotationReference = pdfReference(annotations.values.at(-1));
  const object = resolvePdfObject(structure, annotationReference);
  if (object.stream) throw unsupported();
  const entries = pdfDictionary(object.value);
  if (entries.get('Type')?.type !== 'name' || entries.get('Type').value !== 'Annot'
    || entries.get('Subtype')?.type !== 'name' || entries.get('Subtype').value !== input.annotationSubtype
    || [...ACTIVE_ANNOTATION_KEYS].some((key) => entries.has(key))) throw unsupported();
  if (input.annotationSubtype === 'Line') {
    if (!samePoints(numericArray(entries.get('L'), 4), input.points)) throw unsupported();
  } else {
    const inkList = entries.get('InkList');
    if (inkList?.type !== 'array' || inkList.values.length !== 1) throw unsupported();
    const expected = input.kind === 'distance' ? input.points : [...input.points, input.points[0]];
    if (!samePoints(numericArray(inkList.values[0], expected.length * 2), expected)) throw unsupported();
  }
  return Object.freeze({ reference: annotationReference, entries });
}

function selectTarget(structure, input) {
  const { catalogEntries, pages } = collectPages(structure);
  const page = pages[input.page - 1];
  if (!page || page.entries.has('VP')) throw unsupported();
  return Object.freeze({
    catalogEntries,
    pages,
    page,
    annotation: targetAnnotation(structure, page.entries, input),
  });
}

function numberFormat(unit, conversion) {
  return pdfDict([
    ['Type', pdfName('NumberFormat')],
    ['U', pdfText(unit)],
    ['C', pdfNumber(conversion)],
    ['F', pdfName('D')],
    ['D', pdfNumber(1_000_000)],
  ]);
}

function measureValue(input) {
  return pdfDict([
    ['Type', pdfName('Measure')],
    ['Subtype', pdfName('RL')],
    ['R', pdfText(`${decimal(input.calibrationDistance)} pt = ${decimal(input.calibrationRealLength)} ${input.calibrationUnit}`)],
    ['X', pdfArray([numberFormat('m', input.metersPerPdfPoint)])],
    ['D', pdfArray([numberFormat('m', 1)])],
    ['A', pdfArray([numberFormat('m2', 1)])],
  ]);
}

function viewportValue(input, measureReference) {
  return pdfDict([
    ['Type', pdfName('Viewport')],
    ['BBox', pdfArray(input.pageBox.map(pdfNumber))],
    ['Measure', measureReference],
  ]);
}

function changedId(source, input) {
  return createHash('sha256')
    .update('Platen AEC Measure dictionary ID v1\0', 'utf8')
    .update(createHash('sha256').update(source).digest())
    .update(JSON.stringify(input), 'utf8')
    .digest().subarray(0, 16);
}

function transactionValues(structure, target, input, measureReference, viewportReference) {
  if (structure.finalSize + 2 >= CLASSIC_PDF_STRUCTURE_LIMITS.maxObjectNumber) throw unsupported();
  const pageEntries = new Map(target.page.entries);
  pageEntries.set('VP', pdfArray([viewportReference]));
  const catalogEntries = new Map(target.catalogEntries);
  const currentVersion = catalogEntries.get('Version');
  if (currentVersion !== undefined && (currentVersion.type !== 'name'
    || !/^1[.][0-7]$|^2[.]0$/u.test(currentVersion.value))) throw unsupported();
  const headerVersion = structure.buffer.subarray(5, 8).toString('latin1');
  const versionRequiresCatalog = currentVersion !== undefined
    ? !['1.7', '2.0'].includes(currentVersion.value) : !['1.7', '2.0'].includes(headerVersion);
  if (versionRequiresCatalog) catalogEntries.set('Version', pdfName('1.7'));
  const annotationEntries = new Map(target.annotation.entries);
  if (input.annotationSubtype === 'Line') {
    annotationEntries.set('IT', pdfName('LineDimension'));
    annotationEntries.set('Measure', measureReference);
  }
  const updates = [
    { reference: target.page.reference, value: pdfDict(pageEntries) },
    ...(versionRequiresCatalog ? [{ reference: structure.root, value: pdfDict(catalogEntries) }] : []),
    ...(input.annotationSubtype === 'Line'
      ? [{ reference: target.annotation.reference, value: pdfDict(annotationEntries) }] : []),
  ];
  return Object.freeze({
    updates: Object.freeze(updates),
    additions: Object.freeze([
      Object.freeze({ id: 'measure', value: measureValue(input) }),
      Object.freeze({ id: 'viewport', value: viewportValue(input, measureReference) }),
    ]),
    versionRequiresCatalog,
  });
}

function canonicalAppend(source, structure, target, input) {
  try {
    const pending = transactionValues(
      structure,
      target,
      input,
      pendingPdfObjectReference('measure'),
      pendingPdfObjectReference('viewport'),
    );
    const transaction = planPdfObjectTransaction({
      sourceBytes: source,
      sourceStructure: structure,
      updates: pending.updates,
      additions: pending.additions,
      info: { kind: 'preserve' },
      changingId: structure.id ? changedId(source, input) : null,
    });
    const measureReference = transaction.referencesById.measure;
    const viewportReference = transaction.referencesById.viewport;
    const expected = transactionValues(
      structure, target, input, measureReference, viewportReference,
    );
    const records = Object.freeze([
      ...expected.updates,
      ...expected.additions.map(({ id, value }) => ({
        reference: transaction.referencesById[id], value,
      })),
    ].sort((left, right) => left.reference.object - right.reference.object));
    if (new Set(records.map((record) => record.reference.object)).size !== records.length) {
      throw unsupported();
    }
    const revision = transaction.revision;
    return Object.freeze({
      records,
      measureReference,
      viewportReference,
      versionRequiresCatalog: expected.versionRequiresCatalog,
      revision,
      bytes: revision.bytes,
      offsets: Object.freeze(revision.records.map(({ offset }) => offset)),
      xrefOffset: revision.xrefOffset,
    });
  } catch {
    throw unsupported();
  }
}

function proof(source, output, append, target, input) {
  return Object.freeze({
    profile: AEC_MEASURE_DICTIONARY_PROFILE,
    sourceBytes: source.length,
    outputBytes: output.buffer.length,
    appendedBytes: append.bytes.length,
    sourcePrefixPreserved: true,
    sourceRevisionCount: output.revisions.length - 1,
    revisionCount: output.revisions.length,
    previousXrefOffset: output.revisions[1].offset,
    appendedXrefOffset: append.xrefOffset,
    effectiveSize: output.finalSize,
    page: input.page,
    pageObjectNumber: target.page.reference.object,
    annotationObjectNumber: target.annotation.reference.object,
    measurementDictionaryObjectNumber: append.measureReference.object,
    viewportObjectNumber: append.viewportReference.object,
    measurementDictionaryScope: input.annotationSubtype === 'Line'
      ? 'line-and-page-viewport' : 'page-viewport',
    catalogVersionRaised: append.versionRequiresCatalog,
    rootPreserved: true,
    infoPreserved: true,
    idPolicy: output.id ? 'permanent-preserved-changing-updated' : 'absent',
  });
}

function inspectWithSource(sourceBytes, outputBytes, input, source, target) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length
      || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput();
    const append = canonicalAppend(sourceBytes, source, target, input);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({
      sourceBytes,
      outputBytes,
      sourceStructure: source,
      expectedRevision: append.revision,
    }).outputStructure;
    if (output.revisions.length !== source.revisions.length + 1
      || output.revisions[0].offset !== append.xrefOffset
      || pdfInteger(output.revisions[0].trailer.get('Prev')) !== source.revisions[0].offset
      || output.finalSize !== source.finalSize + 2 || !sameReference(output.root, source.root)
      || (source.info === null) !== (output.info === null)
      || (source.info && !sameReference(output.info, source.info))
      || output.revisions[0].entries.length !== append.records.length) throw invalidOutput();
    const replaced = new Set(append.records.map((record) => record.reference.object));
    append.records.forEach((record, index) => {
      const entry = output.revisions[0].entries[index];
      if (entry.object !== record.reference.object || entry.generation !== record.reference.generation
        || entry.offset !== append.offsets[index] || entry.status !== 'n'
        || serializePdfValue(resolvePdfObject(output, record.reference).value) !== serializePdfValue(record.value)) throw invalidOutput();
    });
    for (const [number, entry] of source.effective) {
      const next = output.effective.get(number);
      if (!next || (!replaced.has(number) && (
        next.generation !== entry.generation || next.status !== entry.status
        || (entry.status === 'c'
          ? next.objectStream !== entry.objectStream || next.index !== entry.index
          : next.offset !== entry.offset)
      ))) throw invalidOutput();
    }
    if ((source.id === null) !== (output.id === null)
      || (source.id && (!output.id[0].equals(source.id[0])
        || !output.id[1].equals(changedId(sourceBytes, input))))) throw invalidOutput();
    return proof(sourceBytes, output, append, target, input);
  } catch (error) {
    if (error?.code === 'INVALID_AEC_MEASURE_DICTIONARY_OUTPUT') throw error;
    throw invalidOutput();
  }
}

export function inspectIncrementalAecMeasureDictionary(sourceBytes, outputBytes, inputValue) {
  const input = normalizeAecMeasureDictionaryInput(inputValue);
  const source = parseSource(sourceBytes);
  return inspectWithSource(sourceBytes, outputBytes, input, source, selectTarget(source, input));
}

export function writeIncrementalAecMeasureDictionary(sourceBytes, inputValue) {
  const input = normalizeAecMeasureDictionaryInput(inputValue);
  const source = parseSource(sourceBytes);
  const entryCount = source.revisions.reduce((sum, revision) => sum + revision.entries.length, 0);
  if (source.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions
    || entryCount + 5 > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported();
  const target = selectTarget(source, input);
  const append = canonicalAppend(sourceBytes, source, target, input);
  const bytes = Buffer.concat([sourceBytes, append.bytes]);
  return Object.freeze({ bytes, proof: inspectWithSource(sourceBytes, bytes, input, source, target) });
}
