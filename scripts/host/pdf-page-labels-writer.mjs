import { createHash } from 'node:crypto';
import { pdfDictionary, pdfInteger, pdfReference, pdfStringBytes } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import { PDF_PAGE_LABELS_PROFILE, normalizePdfPageLabels } from './pdf-page-labels-contract.mjs';
export { PDF_PAGE_LABELS_PROFILE };

const MAX_PAGES = 1_000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const UNSAFE_KEYS = new Set(['A', 'AA', 'AcroForm', 'AF', 'ByteRange', 'Collection', 'Encrypt', 'EmbeddedFiles', 'Filespec', 'JS', 'JavaScript', 'Metadata', 'Names', 'OCProperties', 'OpenAction', 'Outlines', 'Perms', 'PieceInfo', 'Sig', 'StructTreeRoot', 'XFA']);
const UNSAFE_TYPES = new Set(['Action', 'Annot', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Sig', 'StructElem']);
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'PDF is outside the supported bounded page-labels subset.') { return failure('UNSUPPORTED_PDF_PAGE_LABELS_PDF', message); }
function invalidOutput() { return failure('INVALID_PDF_PAGE_LABELS_OUTPUT', 'PDF page-labels output proof failed.'); }
function sameReference(left, right) { return left.object === right.object && left.generation === right.generation; }
function referenceKey(reference) { return `${reference.object}:${reference.generation}`; }
function pdfName(value) { return Object.freeze({ type: 'name', value }); }
function pdfNumber(value) { return Object.freeze({ type: 'number', value, integer: true, raw: String(value) }); }
function pdfString(value) { return pdfUtf16BeString(value); }
function pdfArray(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function pdfDict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function rejectUnsafeValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value.type === 'dict') {
    for (const [key, child] of value.entries) {
      if (UNSAFE_KEYS.has(key) || key === 'FT' || key === 'S' || value.entries.get('Type')?.type === 'name' && UNSAFE_TYPES.has(value.entries.get('Type').value)) throw unsupported('Active, signed, tagged, layered, or attached PDF content is unsupported.');
      rejectUnsafeValue(child, seen);
    }
  } else if (value.type === 'array') for (const child of value.values) rejectUnsafeValue(child, seen);
}

function directBox(value) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry.type !== 'number' || !entry.integer)) throw unsupported('Page boxes must be direct integer arrays.');
  const box = value.values.map((entry) => pdfInteger(entry));
  if (box[0] >= box[2] || box[1] >= box[3]) throw unsupported('Page boxes must have positive dimensions.');
  return Object.freeze(box);
}

function collectPages(structure) {
  try {
    const catalogObject = resolvePdfObject(structure, structure.root); if (catalogObject.stream) throw unsupported();
    const catalog = pdfDictionary(catalogObject.value);
    if (catalog.get('Type')?.type !== 'name' || catalog.get('Type').value !== 'Catalog' || [...UNSAFE_KEYS].some((key) => catalog.has(key)) || catalog.has('PageLabels')) throw unsupported('The passive catalog must not already contain page labels or active content.');
    const pagesReference = pdfReference(catalog.get('Pages')); const pagesObject = resolvePdfObject(structure, pagesReference); if (pagesObject.stream) throw unsupported(); const pagesRoot = pdfDictionary(pagesObject.value);
    if (pagesRoot.get('Type')?.value !== 'Pages' || pagesRoot.has('Parent')) throw unsupported('Only a flat direct page tree is supported.');
    const kids = pagesRoot.get('Kids'); if (kids?.type !== 'array' || kids.values.length < 1 || kids.values.length > MAX_PAGES || pdfInteger(pagesRoot.get('Count')) !== kids.values.length) throw unsupported('Page-tree counts and children must be direct and exact.');
    const references = kids.values.map((entry) => pdfReference(entry)); if (new Set(references.map(referenceKey)).size !== references.length) throw unsupported('Page-tree children must not alias.');
    const pages = []; for (const reference of references) {
      const object = resolvePdfObject(structure, reference); if (object.stream) throw unsupported(); const entries = pdfDictionary(object.value); const type = entries.get('Type')?.value;
      if (type !== 'Page' || !sameReference(pdfReference(entries.get('Parent')), pagesReference) || entries.has('Annots') || entries.has('AA') || entries.has('A') || entries.has('Metadata')) throw unsupported('Pages must be passive direct page objects.');
      const media = directBox(entries.get('MediaBox')); const crop = directBox(entries.get('CropBox')); if (media[0] > crop[0] || media[1] > crop[1] || media[2] < crop[2] || media[3] < crop[3]) throw unsupported('CropBox must be contained by MediaBox.');
      pages.push(Object.freeze({ reference, media, crop }));
    }
    if (pages.length < 1 || pages.length > MAX_PAGES) throw unsupported();
    visitPdfObjects(structure, (object) => { if (object.reference.object !== structure.root.object) rejectUnsafeValue(object.value); });
    return Object.freeze({ catalogObject, catalog, pagesReference, pages });
  } catch (error) { if (error?.code === 'UNSUPPORTED_PDF_PAGE_LABELS_PDF') throw error; throw unsupported(); }
}

function roman(value) {
  const parts = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let result = '';
  for (const [unit, glyph] of parts) { while (value >= unit) { result += glyph; value -= unit; } }
  return result;
}
function letters(value) { let result = ''; while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); } return result; }
function labelText(range, page) {
  const number = range.startNumber === undefined ? null : range.startNumber + page - range.start;
  const body = range.style === 'none' ? '' : range.style === 'D' ? String(number) : range.style === 'R' ? roman(number) : range.style === 'r' ? roman(number).toLowerCase() : range.style === 'A' ? letters(number) : letters(number).toLowerCase();
  return `${range.prefix}${body}`;
}
function resolvedLabels(pageCount, ranges) {
  const labels = []; let rangeIndex = -1;
  for (let page = 0; page < pageCount; page += 1) { while (rangeIndex + 1 < ranges.length && ranges[rangeIndex + 1].start <= page) rangeIndex += 1; labels.push(rangeIndex < 0 ? String(page + 1) : labelText(ranges[rangeIndex], page)); }
  if (labels.some((label) => Buffer.byteLength(label, 'utf8') > 1024)) throw unsupported('Resolved page labels exceed the bounded evidence limit.');
  return Object.freeze(labels);
}
function rangeDictionary(range) { return pdfDict([...(range.prefix ? [['P', pdfString(range.prefix)]] : []), ...(range.style === 'none' ? [] : [['S', pdfName(range.style)], ['St', pdfNumber(range.startNumber)]])]); }
function expectedAppend(sourceBytes, structure, state, request) {
  const nums = []; for (const range of request.ranges) nums.push(pdfNumber(range.start), rangeDictionary(range));
  const pageLabels = pdfDict([['Nums', pdfArray(nums)]]); const catalog = pdfDict([...state.catalog, ['PageLabels', pageLabels]]);
  try {
    const revision = planPdfObjectTransaction({ sourceBytes, sourceStructure: structure, updates: [{ reference: structure.root, value: catalog }], additions: [], info: { kind: 'preserve' }, changingId: null }).revision;
    return Object.freeze({ revision, bytes: revision.bytes, labels: resolvedLabels(state.pages.length, request.ranges) });
  } catch { throw unsupported(); }
}

function parseSource(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 32 || sourceBytes.length > MAX_SOURCE_BYTES || digest(sourceBytes) !== request.sourceSha256) throw failure('INVALID_PDF_PAGE_LABELS', 'The source digest does not match source bytes.');
  let structure; try { structure = parsePdfStructure(sourceBytes); } catch { throw unsupported(); }
  if (structure.xrefFlavor !== 'classic' || structure.revisions.length !== 1 || structure.id || structure.info || structure.revisions[0].trailer.has('Encrypt') || structure.effective.size > CLASSIC_PDF_STRUCTURE_LIMITS.maxTotalXrefEntries) throw unsupported('Only passive unsigned single-revision classic PDFs are supported.');
  return structure;
}
function verify(sourceBytes, outputBytes, request, structure, state, append) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes) || !outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: structure, expectedRevision: append.revision }).outputStructure;
    const root = pdfDictionary(resolvePdfObject(output, output.root).value); const labels = root.get('PageLabels'); const nums = labels?.type === 'dict' ? labels.entries.get('Nums') : null;
    if (output.revisions.length !== 2 || output.revisions[0].entries.length !== 1 || output.revisions[0].entries[0].object !== structure.root.object || nums?.type !== 'array' || nums.values.length !== request.ranges.length * 2) throw invalidOutput();
    for (let index = 0; index < request.ranges.length; index += 1) {
      const range = request.ranges[index]; const start = nums.values[index * 2]; const dict = nums.values[index * 2 + 1];
      if (pdfInteger(start) !== range.start || dict?.type !== 'dict') throw invalidOutput();
      const entries = dict.entries; if ([...entries.keys()].some((key) => !['P', 'S', 'St'].includes(key)) || (range.prefix ? entries.get('P')?.type !== 'string' || !pdfStringBytes(entries.get('P')).equals(pdfString(range.prefix).bytes) : entries.has('P'))) throw invalidOutput();
      if (range.style === 'none') { if (entries.has('S') || entries.has('St')) throw invalidOutput(); }
      else if (entries.get('S')?.type !== 'name' || entries.get('S').value !== range.style || pdfInteger(entries.get('St')) !== range.startNumber) throw invalidOutput();
    }
    for (const [number, entry] of structure.effective) { const after = output.effective.get(number); if (!after || number !== structure.root.object && (after.status !== entry.status || after.generation !== entry.generation || after.offset !== entry.offset)) throw invalidOutput(); }
    return Object.freeze({ profile: PDF_PAGE_LABELS_PROFILE, sourceSha256: digest(sourceBytes), sourceBytes: sourceBytes.length, outputBytes: outputBytes.length, appendedBytes: append.bytes.length, sourcePrefixPreserved: true, onlyCatalogChanged: true, revisionCount: output.revisions.length, pageCount: state.pages.length, ranges: Object.freeze(request.ranges.map(({ start, style, prefix, startNumber }) => Object.freeze({ start, style, prefix, ...(startNumber === undefined ? {} : { startNumber }) }))), labels: append.labels, catalogReference: `${output.root.object}:${output.root.generation}` });
  } catch (error) { if (error?.code === 'INVALID_PDF_PAGE_LABELS_OUTPUT') throw error; throw invalidOutput(); }
}
export function inspectPdfPageLabels(sourceBytes, outputBytes, requestValue) { const request = normalizePdfPageLabels(requestValue); const structure = parseSource(sourceBytes, request); const state = collectPages(structure); if (request.ranges.at(-1).start >= state.pages.length) throw failure('INVALID_PDF_PAGE_LABELS', 'A page-label range start is outside the source page count.'); const append = expectedAppend(sourceBytes, structure, state, request); return verify(sourceBytes, outputBytes, request, structure, state, append); }
export function writePdfPageLabels(sourceBytes, requestValue) { const request = normalizePdfPageLabels(requestValue); const structure = parseSource(sourceBytes, request); if (structure.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions) throw unsupported(); const state = collectPages(structure); if (request.ranges.at(-1).start >= state.pages.length) throw failure('INVALID_PDF_PAGE_LABELS', 'A page-label range start is outside the source page count.'); const append = expectedAppend(sourceBytes, structure, state, request); const bytes = Buffer.concat([sourceBytes, append.bytes]); return Object.freeze({ bytes, proof: verify(sourceBytes, bytes, request, structure, state, append) }); }
export const writeIncrementalPdfPageLabels = writePdfPageLabels;
export const inspectIncrementalPdfPageLabels = inspectPdfPageLabels;
