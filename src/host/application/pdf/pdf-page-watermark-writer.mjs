import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { normalizePdfPageWatermark, PDF_PAGE_WATERMARK_APPEARANCE, PDF_PAGE_WATERMARK_LIMITS, PDF_PAGE_WATERMARK_PROFILE } from './pdf-page-watermark-contract.mjs';

const FONT_NAME = 'WatermarkHelv';
const UNSAFE = new Set(['AcroForm', 'Annots', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'Outlines', 'XFA', 'ByteRange', 'Sig', 'Tabs', 'PieceInfo', 'Collection', 'Dests', 'Dest', 'GoTo', 'GoToR', 'Launch', 'SubmitForm', 'ImportData', 'RichMedia', '3D', 'Threads', 'ViewerPreferences', 'Lang', 'OutputIntents', 'Requirements', 'Legal', 'SpiderInfo', 'TrapNet', 'RoleMap', 'ParentTree', 'ActualText', 'Alt', 'E', 'AP', 'AS', 'OC', 'Encrypt']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'The source is outside the passive page-watermark subset.') { throw failure('UNSUPPORTED_PDF_PAGE_WATERMARK', message); }
function invalidOutput(message = 'PDF page-watermark output verification failed.') { throw failure('INVALID_PDF_PAGE_WATERMARK_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function same(a, b) { return a?.object === b?.object && a?.generation === b?.generation; }
function number(value, raw = String(value)) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw }); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function referenceText(reference) { return `${reference.object} ${reference.generation} R`; }
function equalValue(left, right) {
  if (!left || !right || left.type !== right.type) return left === right;
  if (left.type === 'ref') return same(left, right);
  if (left.type === 'dict') return left.entries.size === right.entries.size && [...left.entries].every(([key, value]) => equalValue(value, right.entries.get(key)));
  if (left.type === 'array') return left.values.length === right.values.length && left.values.every((value, index) => equalValue(value, right.values[index]));
  if (left.type === 'string') return Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
  return left.value === right.value;
}
function reject(value, structure, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'ref') { const key = `${value.object}:${value.generation}`; if (seen.has(key)) return; seen.add(key); reject(resolveClassicPdfObject(structure, value).value, structure, seen); return; }
  if (value.type === 'dict') { for (const [key, child] of value.entries) { if (UNSAFE.has(key)) unsupported('Active, signed, tagged, layered, form, or annotated PDF content is unsupported.'); reject(child, structure, seen); } }
  else if (value.type === 'array') value.values.forEach((child) => reject(child, structure, seen));
}
function rejectResourceAliases(value) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'ref') unsupported('Indirect nested resource aliases are outside the passive watermark subset.');
  if (value.type === 'dict') for (const child of value.entries.values()) rejectResourceAliases(child);
  if (value.type === 'array') value.values.forEach(rejectResourceAliases);
}
function box(value, label) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry?.type !== 'number' || !Number.isFinite(entry.value))) unsupported(`${label} must be an explicit finite four-number array.`);
  const result = value.values.map((entry) => entry.value);
  if (!(result[2] > result[0] && result[3] > result[1])) unsupported(`${label} must have positive dimensions.`);
  return Object.freeze(result);
}
function textBytes(value) { return Buffer.from(value, 'latin1'); }
function hex(value) { return `<${textBytes(value).toString('hex').toUpperCase()}>`; }
function fmt(value) { return Number(value.toFixed(4)).toString(); }
function watermarkStream(crop, text) {
  const width = [...text].length * PDF_PAGE_WATERMARK_APPEARANCE.fontSize * 0.6;
  const x = (crop[0] + crop[2] - width) / 2;
  const y = (crop[1] + crop[3] - PDF_PAGE_WATERMARK_APPEARANCE.fontSize) / 2;
  if (x < crop[0] || y < crop[1] || x + width > crop[2] || y + PDF_PAGE_WATERMARK_APPEARANCE.fontSize > crop[3]) throw failure('INVALID_PDF_PAGE_WATERMARK', 'Watermark text does not fit the selected page box.');
  return Buffer.from(`q\n0 0 0 rg\nBT\n/${FONT_NAME} ${PDF_PAGE_WATERMARK_APPEARANCE.fontSize} Tf\n${fmt(x)} ${fmt(y)} Td\n${hex(text)} Tj\nET\nQ\n`, 'latin1');
}
function pageState(source, request) {
  if (!Buffer.isBuffer(source) || source.length < 32 || source.length > PDF_PAGE_WATERMARK_LIMITS.maxSourceBytes || digest(source) !== request.sourceSha256) throw failure('INVALID_PDF_PAGE_WATERMARK', 'Source digest mismatch.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported(); }
  if (structure.revisions.length !== 1 || structure.revisions[0].xrefKind === 'stream' || structure.id || structure.info || structure.revisions[0].trailer?.has?.('Encrypt')) unsupported('Only one unsigned classic revision without IDs, Info, or encryption is supported.');
  for (const entry of structure.effective.values()) if (entry.status === 'n') reject({ type: 'ref', object: entry.object, generation: entry.generation }, structure);
  const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value); const pagesRef = catalog.get('Pages');
  if (catalog.size !== 2 || catalog.get('Type')?.value !== 'Catalog' || pagesRef?.type !== 'ref') unsupported();
  const pagesObject = pdfDictionary(resolveClassicPdfObject(structure, pagesRef).value); const kids = pagesObject.get('Kids');
  if (pagesObject.get('Type')?.value !== 'Pages' || kids?.type !== 'array' || pagesObject.get('Count')?.value !== kids.values.length || kids.values.length < 1 || kids.values.length > PDF_PAGE_WATERMARK_LIMITS.maxPages) unsupported();
  const contentRefs = new Set(); const pages = kids.values.map((ref) => {
    if (ref.type !== 'ref') unsupported(); const value = pdfDictionary(resolveClassicPdfObject(structure, ref).value);
    if (value.get('Type')?.value !== 'Page' || !same(value.get('Parent'), pagesRef) || value.get('Resources')?.type !== 'dict' || value.get('Contents')?.type !== 'ref' || value.has('Annots')) unsupported('Pages must use direct resources, direct content streams, and no annotations.');
    const rotate = value.get('Rotate'); if (rotate && (rotate.type !== 'number' || rotate.value !== 0)) unsupported('Rotated pages are unsupported.');
    const resources = value.get('Resources'); const fonts = resources.entries.get('Font');
    if (fonts && fonts.type !== 'dict') unsupported('The existing Font resource must be a direct dictionary.');
    if (fonts?.entries.has(FONT_NAME)) unsupported('The dedicated watermark font resource name collides with an existing font.');
    for (const [key, child] of resources.entries) if (key !== 'Font') rejectResourceAliases(child);
    const media = box(value.get('MediaBox'), 'MediaBox'); const crop = box(value.get('CropBox'), 'CropBox'); if (!media.every((entry, index) => entry === crop[index])) unsupported('Selected pages must have CropBox exactly equal to MediaBox.');
    const contentReference = value.get('Contents'); const contentKey = `${contentReference.object}:${contentReference.generation}`; if (contentRefs.has(contentKey)) unsupported('Content streams must not be aliased across pages.'); contentRefs.add(contentKey); const content = resolveClassicPdfObject(structure, contentReference); if (!content.stream) unsupported('Page content must be a direct stream.');
    return Object.freeze({ ref, value, media, crop, content });
  });
  request.pages.forEach((page) => { if (!pages[page - 1]) throw failure('INVALID_PDF_PAGE_WATERMARK', 'Selected page is outside the document.'); });
  return Object.freeze({ structure, pages });
}
function build(sourceBytes, request) {
  const state = pageState(sourceBytes, request); const font = pendingClassicObjectReference('font'); const additions = [{ id: 'font', value: dict([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')], ['Encoding', name('WinAnsiEncoding')]]) }]; const updates = []; const proofs = [];
  request.pages.forEach((pageNumber) => { const page = state.pages[pageNumber - 1]; const resources = new Map(page.value.get('Resources').entries); const fonts = resources.get('Font'); const fontEntries = fonts?.type === 'dict' ? new Map(fonts.entries) : new Map(); fontEntries.set(FONT_NAME, font); resources.set('Font', dict(fontEntries)); const stream = watermarkStream(page.crop, request.text); const streamRef = pendingClassicObjectReference(`content-${pageNumber}`); additions.push({ id: `content-${pageNumber}`, value: dict([['Length', number(stream.length)]]), streamBytes: stream }); const pageValue = new Map(page.value); pageValue.set('Resources', dict(resources)); pageValue.set('Contents', array([page.value.get('Contents'), streamRef])); updates.push({ reference: page.ref, value: dict(pageValue) }); proofs.push(Object.freeze({ page: pageNumber, text: request.text, stream: streamRef, crop: page.crop, appearance: PDF_PAGE_WATERMARK_APPEARANCE })); });
  const transaction = planClassicObjectTransaction({ sourceBytes, sourceStructure: state.structure, updates, additions, info: { kind: 'preserve' }, changingId: null }); const bytes = Buffer.concat([sourceBytes, transaction.revision.bytes]);
  return { state, bytes, proof: Object.freeze({ profile: PDF_PAGE_WATERMARK_PROFILE, sourceSha256: request.sourceSha256, outputSha256: digest(bytes), pageCount: state.pages.length, pages: Object.freeze(proofs), sourcePrefixPreserved: true, revisionCount: 2, resourceName: FONT_NAME, font: transaction.referencesById.font }) };
}
function verify(sourceBytes, outputBytes, request, state, expected) {
  if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) invalidOutput('Source prefix was not preserved.');
  let output; try { output = parseClassicPdfStructure(outputBytes); } catch { invalidOutput(); }
  if (output.revisions.length !== 2 || output.revisions.some((revision) => revision.xrefKind && revision.xrefKind !== 'classic') || !same(output.root, state.structure.root)) invalidOutput('Output revision or root changed.');
  const catalog = pdfDictionary(resolveClassicPdfObject(output, output.root).value); const pagesRef = catalog.get('Pages'); const pagesValue = pagesRef?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(output, pagesRef).value) : null; const kids = pagesValue?.get('Kids');
  if (!pagesValue || pagesValue.get('Type')?.value !== 'Pages' || kids?.type !== 'array' || kids.values.length !== state.pages.length) invalidOutput('Page tree changed.');
  const selected = new Map(request.pages.map((page, index) => [page, index])); const sourceObjects = new Set([...state.structure.effective.keys()]); const outputObjects = new Set([...output.effective.keys()]); const added = [...outputObjects].filter((object) => !sourceObjects.has(object)); const streams = new Set(); let fontRef = null; let fontValue = null; const pages = [];
  for (let index = 0; index < state.pages.length; index += 1) {
    const pageNumber = index + 1; const sourcePage = state.pages[index]; const pageRef = kids.values[index]; const pageValue = pageRef?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(output, pageRef).value) : null; if (!same(pageRef, sourcePage.ref) || !pageValue) invalidOutput('Page topology changed.');
    const selectedIndex = selected.get(pageNumber); if (selectedIndex === undefined) { if (!equalValue(pageValue, sourcePage.value)) invalidOutput('An unselected page changed.'); continue; }
    for (const [key, value] of sourcePage.value) if (key !== 'Resources' && key !== 'Contents' && !equalValue(value, pageValue.get(key))) invalidOutput('An original page entry changed.');
    const resources = pageValue.get('Resources'); const sourceResources = sourcePage.value.get('Resources'); const contents = pageValue.get('Contents');
    if (resources?.type !== 'dict' || sourceResources?.type !== 'dict' || contents?.type !== 'array' || contents.values.length !== 2 || !equalValue(contents.values[0], sourcePage.value.get('Contents'))) invalidOutput('Watermark page topology is invalid.');
    const fonts = resources.entries.get('Font'); const sourceFonts = sourceResources.entries.get('Font'); const ref = fonts?.type === 'dict' ? fonts.entries.get(FONT_NAME) : null; const value = ref?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(output, ref).value) : null;
    if (fonts?.type !== 'dict' || ref?.type !== 'ref' || !value || value.size !== 4 || value.get('Type')?.value !== 'Font' || value.get('Subtype')?.value !== 'Type1' || value.get('BaseFont')?.value !== 'Helvetica' || value.get('Encoding')?.value !== 'WinAnsiEncoding') invalidOutput('Watermark font resource is invalid.');
    const expectedResourceKeys = [...new Set([...sourceResources.entries.keys(), 'Font'])].sort(); if (JSON.stringify([...resources.entries.keys()].sort()) !== JSON.stringify(expectedResourceKeys)) invalidOutput('Watermark resource topology changed.');
    for (const [key, child] of sourceResources.entries) if (key !== 'Font' && !equalValue(resources.entries.get(key), child)) invalidOutput('Original resource entry changed.');
    if (sourceFonts?.type === 'dict') for (const [key, child] of sourceFonts.entries) if (!equalValue(fonts.entries.get(key), child)) invalidOutput('Original font resource changed.');
    if (fontRef && !same(fontRef, ref)) invalidOutput('Watermark font was not shared.'); fontRef = ref; fontValue ??= value; if (!equalValue(fontValue, value)) invalidOutput('Watermark font changed.');
    const streamRef = contents.values[1]; const stream = streamRef?.type === 'ref' ? resolveClassicPdfObject(output, streamRef) : null; const expectedStream = watermarkStream(sourcePage.crop, request.text);
    if (streamRef?.type !== 'ref' || streams.has(streamRef.object) || !stream.stream || stream.streamLength !== expectedStream.length || !outputBytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength).equals(expectedStream)) invalidOutput('Watermark text/effect stream is invalid.');
    streams.add(streamRef.object); pages.push(Object.freeze({ page: pageNumber, text: request.text, applied: true }));
  }
  const expectedAdded = new Set([fontRef?.object, ...streams].filter(Number.isSafeInteger)); const latest = new Set(output.revisions[0].entries.filter((entry) => entry.status === 'n').map((entry) => entry.object)); const expectedChanged = new Set([...state.pages.map((page, index) => selected.has(index + 1) ? page.ref.object : null).filter(Number.isSafeInteger), ...expectedAdded]);
  if (added.length !== expectedAdded.size || added.some((object) => !expectedAdded.has(object)) || latest.size !== expectedChanged.size || [...latest].some((object) => !expectedChanged.has(object))) invalidOutput('Unexpected incremental objects were written.');
  return Object.freeze({ profile: PDF_PAGE_WATERMARK_PROFILE, sourceSha256: digest(sourceBytes), outputSha256: digest(outputBytes), pageCount: state.pages.length, pages: Object.freeze(pages), sourcePrefixPreserved: true, revisionCount: 2, resourceName: FONT_NAME, appearance: PDF_PAGE_WATERMARK_APPEARANCE, effect: 'opaque-text' });
}

export function writePdfPageWatermark(sourceBytes, requestValue) { const request = normalizePdfPageWatermark(requestValue); const built = build(sourceBytes, request); const proof = verify(sourceBytes, built.bytes, request, built.state, built.proof); return Object.freeze({ bytes: built.bytes, proof }); }
export function inspectPdfPageWatermark(sourceBytes, outputBytes, requestValue) { const request = normalizePdfPageWatermark(requestValue); const state = pageState(sourceBytes, request); return verify(sourceBytes, outputBytes, request, state, null); }
export const writeIncrementalPdfPageWatermark = writePdfPageWatermark;
export const inspectIncrementalPdfPageWatermark = inspectPdfPageWatermark;
