import {
  pdfDictionary,
  pdfInteger,
  pdfReference,
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
import {
  changedAecMeasureId,
  invalidAecMeasureOutput,
  validateAecOutputEnvelope,
  validateAecParsedOutput,
} from './pdf-aec-measure-output-validation.mjs';

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
  return invalidAecMeasureOutput();
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
  const result = expandedDecimal(source);
  if (Number(result) !== value) throw unsupported();
  return result;
}

function expandedDecimal(source) {
  const sign = source.startsWith('-') ? '-' : '';
  const unsigned = sign ? source.slice(1) : source;
  const [coefficient, exponentText] = unsigned.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const dot = coefficient.indexOf('.');
  const digits = coefficient.replace('.', '');
  const decimalIndex = (dot === -1 ? coefficient.length : dot) + exponent;
  if (decimalIndex <= 0) return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
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
  validateAnnotationIdentity(entries, input.annotationSubtype);
  validateAnnotationGeometry(entries, input);
  return Object.freeze({ reference: annotationReference, entries });
}

function validateAnnotationGeometry(entries, input) {
  if (input.annotationSubtype === 'Line') {
    if (!samePoints(numericArray(entries.get('L'), 4), input.points)) throw unsupported();
    return;
  }
  const inkList = entries.get('InkList');
  if (inkList?.type !== 'array' || inkList.values.length !== 1) throw unsupported();
  const expected = input.kind === 'distance' ? input.points : [...input.points, input.points[0]];
  if (!samePoints(numericArray(inkList.values[0], expected.length * 2), expected)) {
    throw unsupported();
  }
}

function validateAnnotationIdentity(entries, annotationSubtype) {
  const type = entries.get('Type');
  if (type?.type !== 'name') throw unsupported();
  if (type.value !== 'Annot') throw unsupported();
  const subtype = entries.get('Subtype');
  if (subtype?.type !== 'name') throw unsupported();
  if (subtype.value !== annotationSubtype) throw unsupported();
  if ([...ACTIVE_ANNOTATION_KEYS].some((key) => entries.has(key))) throw unsupported();
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

function transactionValues({
  structure, target, input, measureReference, viewportReference,
}) {
  if (structure.finalSize + 2 >= CLASSIC_PDF_STRUCTURE_LIMITS.maxObjectNumber) throw unsupported();
  const pageEntries = new Map(target.page.entries);
  pageEntries.set('VP', pdfArray([viewportReference]));
  const catalog = updatedCatalog(structure, target);
  const annotation = updatedAnnotation(target, input, measureReference);
  const updates = [
    { reference: target.page.reference, value: pdfDict(pageEntries) },
    ...(catalog.required ? [{ reference: structure.root, value: pdfDict(catalog.entries) }] : []),
    ...(annotation ? [{ reference: target.annotation.reference, value: pdfDict(annotation) }] : []),
  ];
  return Object.freeze({
    updates: Object.freeze(updates),
    additions: Object.freeze([
      Object.freeze({ id: 'measure', value: measureValue(input) }),
      Object.freeze({ id: 'viewport', value: viewportValue(input, measureReference) }),
    ]),
    versionRequiresCatalog: catalog.required,
  });
}

function updatedCatalog(structure, target) {
  const catalogEntries = new Map(target.catalogEntries);
  const currentVersion = catalogEntries.get('Version');
  if (currentVersion !== undefined && currentVersion.type !== 'name') throw unsupported();
  if (currentVersion !== undefined && !/^1[.][0-7]$|^2[.]0$/u.test(currentVersion.value)) {
    throw unsupported();
  }
  const headerVersion = structure.buffer.subarray(5, 8).toString('latin1');
  const versionRequiresCatalog = currentVersion !== undefined
    ? !['1.7', '2.0'].includes(currentVersion.value) : !['1.7', '2.0'].includes(headerVersion);
  if (versionRequiresCatalog) catalogEntries.set('Version', pdfName('1.7'));
  return Object.freeze({ entries: catalogEntries, required: versionRequiresCatalog });
}

function updatedAnnotation(target, input, measureReference) {
  if (input.annotationSubtype !== 'Line') return null;
  const annotationEntries = new Map(target.annotation.entries);
  annotationEntries.set('IT', pdfName('LineDimension'));
  annotationEntries.set('Measure', measureReference);
  return annotationEntries;
}

function canonicalAppend(source, structure, target, input) {
  try {
    const pending = transactionValues({
      structure,
      target,
      input,
      measureReference: pendingPdfObjectReference('measure'),
      viewportReference: pendingPdfObjectReference('viewport'),
    });
    const transaction = planPdfObjectTransaction({
      sourceBytes: source,
      sourceStructure: structure,
      updates: pending.updates,
      additions: pending.additions,
      info: { kind: 'preserve' },
      changingId: structure.id ? changedAecMeasureId(source, input) : null,
    });
    const measureReference = transaction.referencesById.measure;
    const viewportReference = transaction.referencesById.viewport;
    const expected = transactionValues({
      structure, target, input, measureReference, viewportReference,
    });
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

function proof({ source, output, append, target, input }) {
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

function inspectWithSource({ sourceBytes, outputBytes, input, source, target }) {
  try {
    validateAecOutputEnvelope(sourceBytes, outputBytes);
    const append = canonicalAppend(sourceBytes, source, target, input);
    if (!outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({
      sourceBytes,
      outputBytes,
      sourceStructure: source,
      expectedRevision: append.revision,
    }).outputStructure;
    const validatedOutput = validateAecParsedOutput({
      source, output, append, sourceBytes, input,
    });
    return proof({ source: sourceBytes, output: validatedOutput, append, target, input });
  } catch (error) {
    if (error?.code === 'INVALID_AEC_MEASURE_DICTIONARY_OUTPUT') throw error;
    throw invalidOutput();
  }
}

export function inspectIncrementalAecMeasureDictionary(sourceBytes, outputBytes, inputValue) {
  const input = normalizeAecMeasureDictionaryInput(inputValue);
  const source = parseSource(sourceBytes);
  return inspectWithSource({
    sourceBytes, outputBytes, input, source, target: selectTarget(source, input),
  });
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
  return Object.freeze({
    bytes,
    proof: inspectWithSource({ sourceBytes, outputBytes: bytes, input, source, target }),
  });
}
