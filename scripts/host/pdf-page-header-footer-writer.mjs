import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { tokenizePdfContentStream } from './pdf-content-stream-tokenizer.mjs';
import { normalizePdfPageHeaderFooter, PDF_PAGE_HEADER_FOOTER_APPEARANCE, PDF_PAGE_HEADER_FOOTER_LIMITS, PDF_PAGE_HEADER_FOOTER_PROFILE } from './pdf-page-header-footer-contract.mjs';

const FONT_NAME = 'HeaderFooterMono';
const ISOLATION_PREFIX = Buffer.from('q\n', 'latin1');
const ISOLATION_SUFFIX = Buffer.from('Q\n', 'latin1');
const UNSAFE = new Set(['AcroForm', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'Outlines', 'XFA', 'ByteRange', 'Sig', 'PieceInfo', 'Collection', 'Dests', 'Dest', 'GoTo', 'GoToR', 'Launch', 'SubmitForm', 'ImportData', 'RichMedia', '3D', 'Threads', 'Encrypt']);
function error(code, message) { const value = new Error(message); value.code = code; return value; }
function unsupported(message = 'The source is outside the passive page header/footer subset.') { throw error('UNSUPPORTED_PDF_PAGE_HEADER_FOOTER', message); }
function invalidOutput(message = 'PDF page header/footer output verification failed.') { throw error('INVALID_PDF_PAGE_HEADER_FOOTER_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function same(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function num(value) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw: String(value) }); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function equal(left, right) {
  if (!left || !right || left.type !== right.type) return left === right;
  if (left.type === 'ref') return same(left, right);
  if (left.type === 'dict') return left.entries.size === right.entries.size && [...left.entries].every(([key, value]) => equal(value, right.entries.get(key)));
  if (left.type === 'array') return left.values.length === right.values.length && left.values.every((value, index) => equal(value, right.values[index]));
  if (left.type === 'string') return Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
  return left.value === right.value;
}
function reject(value, structure, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'ref') { const key = `${value.object}:${value.generation}`; if (seen.has(key)) return; seen.add(key); reject(resolveClassicPdfObject(structure, value).value, structure, seen); return; }
  if (value.type === 'dict') for (const [key, child] of value.entries) { if (UNSAFE.has(key)) unsupported('Active, signed, tagged, layered, form, or encrypted PDF content is unsupported.'); reject(child, structure, seen); }
  if (value.type === 'array') value.values.forEach((child) => reject(child, structure, seen));
}
function rejectIndirect(value) { if (!value || typeof value !== 'object') return; if (value.type === 'ref') unsupported('Indirect resource aliases are outside the supported subset.'); if (value.type === 'dict') value.entries.forEach((child) => rejectIndirect(child)); if (value.type === 'array') value.values.forEach(rejectIndirect); }
function box(value, label) { if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((item) => item?.type !== 'number' || !Number.isFinite(item.value))) unsupported(`${label} must be an explicit finite four-number array.`); const result = value.values.map((item) => item.value); if (!(result[2] > result[0] && result[3] > result[1])) unsupported(`${label} must have positive dimensions.`); return Object.freeze(result); }
function hex(value) { return `<${Buffer.from(value, 'latin1').toString('hex').toUpperCase()}>`; }
function fmt(value) { return Number(value.toFixed(4)).toString(); }
function stream(boxes, header, footer) {
  const size = PDF_PAGE_HEADER_FOOTER_APPEARANCE.fontSize; const headerWidth = [...header].length * size * 0.6; const footerText = `${footer}${boxes.page}`; const footerWidth = [...footerText].length * size * 0.6;
  const headerX = (boxes.crop[0] + boxes.crop[2] - headerWidth) / 2; const footerX = (boxes.crop[0] + boxes.crop[2] - footerWidth) / 2;
  const headerY = boxes.crop[3] - size - 18; const footerY = boxes.crop[1] + 18;
  if (headerX < boxes.crop[0] || footerX < boxes.crop[0] || headerX + headerWidth > boxes.crop[2] || footerX + footerWidth > boxes.crop[2] || headerY < boxes.crop[1] || footerY < boxes.crop[1]) throw error('INVALID_PDF_PAGE_HEADER_FOOTER', 'Header or footer does not fit the selected page box.');
  return Buffer.from(`q\n0 0 0 rg\nBT\n/${FONT_NAME} ${size} Tf\n${fmt(headerX)} ${fmt(headerY)} Td\n${hex(header)} Tj\nET\nBT\n/${FONT_NAME} ${size} Tf\n${fmt(footerX)} ${fmt(footerY)} Td\n${hex(footerText)} Tj\nET\nQ\n`, 'latin1');
}
function admitContent(source, content) {
  if (!content?.stream || content.value?.type !== 'dict'
    || [...content.value.entries.keys()].some((key) => !['Length', 'Filter', 'DecodeParms'].includes(key))
    || content.value.entries.get('Length')?.type !== 'number'
    || !content.value.entries.get('Length').integer
    || content.value.entries.get('Length').value !== content.streamLength) unsupported('Page content stream length is ambiguous.');
  let tokenized;
  try { tokenized = tokenizePdfContentStream({ sourceBytes: source, stream: content }); } catch { unsupported('Page content syntax is malformed or unsupported.'); }
  let graphicsDepth = 0; let textDepth = 0; let compatibilityDepth = 0; let markedDepth = 0;
  for (const token of tokenized.tokens) {
    if (token.type === 'name' && token.value === FONT_NAME) unsupported('Existing content references the dedicated header/footer font name.');
    if (token.type !== 'operator') continue;
    if (token.value === 'q') { graphicsDepth += 1; if (graphicsDepth > 32) unsupported('Graphics state nesting is too deep.'); }
    else if (token.value === 'Q') { if (graphicsDepth === 0) unsupported('Graphics state is unbalanced.'); graphicsDepth -= 1; }
    else if (token.value === 'BT') { if (textDepth !== 0) unsupported('Text objects are unbalanced.'); textDepth = 1; }
    else if (token.value === 'ET') { if (textDepth !== 1) unsupported('Text objects are unbalanced.'); textDepth = 0; }
    else if (token.value === 'BX') { compatibilityDepth += 1; if (compatibilityDepth > 32) unsupported('Compatibility sections are too deep.'); }
    else if (token.value === 'EX') { if (compatibilityDepth === 0) unsupported('Compatibility sections are unbalanced.'); compatibilityDepth -= 1; }
    else if (token.value === 'BMC' || token.value === 'BDC') { markedDepth += 1; if (markedDepth > 32) unsupported('Marked-content nesting is too deep.'); }
    else if (token.value === 'EMC') { if (markedDepth === 0) unsupported('Marked content is unbalanced.'); markedDepth -= 1; }
  }
  if (graphicsDepth !== 0 || textDepth !== 0 || compatibilityDepth !== 0 || markedDepth !== 0) unsupported('Page content state is unbalanced.');
}
function state(source, request) {
  if (!Buffer.isBuffer(source) || source.length < 32 || source.length > PDF_PAGE_HEADER_FOOTER_LIMITS.maxSourceBytes || digest(source) !== request.sourceSha256) throw error('INVALID_PDF_PAGE_HEADER_FOOTER', 'Source digest mismatch.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported(); }
  if (structure.revisions.length !== 1 || structure.revisions[0].xrefKind === 'stream' || structure.id || structure.info || structure.revisions[0].trailer?.has?.('Encrypt')) unsupported('Only one unencrypted unsigned classic revision without IDs or Info is supported.');
  for (const entry of structure.effective.values()) if (entry.status === 'n') reject({ type: 'ref', object: entry.object, generation: entry.generation }, structure);
  const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value); const pagesRef = catalog.get('Pages');
  if (catalog.size !== 2 || catalog.get('Type')?.value !== 'Catalog' || pagesRef?.type !== 'ref') unsupported();
  const pagesValue = pdfDictionary(resolveClassicPdfObject(structure, pagesRef).value); const kids = pagesValue.get('Kids');
  if (pagesValue.get('Type')?.value !== 'Pages' || kids?.type !== 'array' || pagesValue.get('Count')?.value !== kids.values.length || kids.values.length < 1 || kids.values.length > PDF_PAGE_HEADER_FOOTER_LIMITS.maxPages) unsupported();
  const contentRefs = new Set(); const pages = kids.values.map((ref, index) => {
    if (ref.type !== 'ref') unsupported(); const value = pdfDictionary(resolveClassicPdfObject(structure, ref).value); const resources = value.get('Resources'); const contents = value.get('Contents');
    if (value.get('Type')?.value !== 'Page' || !same(value.get('Parent'), pagesRef) || resources?.type !== 'dict' || contents?.type !== 'ref') unsupported('Pages must have direct resources and one direct content stream.');
    if (value.get('Rotate') && (value.get('Rotate').type !== 'number' || value.get('Rotate').value !== 0)) unsupported('Rotated pages are unsupported.');
    const fonts = resources.entries.get('Font'); if (fonts && fonts.type !== 'dict') unsupported('Font resources must be direct.'); if (fonts?.entries.has(FONT_NAME)) unsupported('Dedicated font resource name collides with an existing font.');
    for (const [key, child] of resources.entries) if (key !== 'Font') rejectIndirect(child); const media = box(value.get('MediaBox'), 'MediaBox'); const crop = box(value.get('CropBox'), 'CropBox'); if (!media.every((item, position) => item === crop[position])) unsupported('CropBox must equal MediaBox.');
    const contentKey = `${contents.object}:${contents.generation}`; if (contentRefs.has(contentKey)) unsupported('Content streams must not be shared.'); contentRefs.add(contentKey); const content = resolveClassicPdfObject(structure, contents); admitContent(source, content);
    return Object.freeze({ page: index + 1, ref, value, crop });
  });
  request.pages.forEach((page) => { if (!pages[page - 1]) throw error('INVALID_PDF_PAGE_HEADER_FOOTER', 'Selected page is outside the document.'); }); return Object.freeze({ structure, pages });
}
function build(source, request) {
  const sourceState = state(source, request); const font = pendingClassicObjectReference('font'); const prefix = pendingClassicObjectReference('isolation-prefix'); const suffix = pendingClassicObjectReference('isolation-suffix'); const additions = [{ id: 'font', value: dict([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Courier')], ['Encoding', name('WinAnsiEncoding')]]) }, { id: 'isolation-prefix', value: dict([['Length', num(ISOLATION_PREFIX.length)]]), streamBytes: ISOLATION_PREFIX }, { id: 'isolation-suffix', value: dict([['Length', num(ISOLATION_SUFFIX.length)]]), streamBytes: ISOLATION_SUFFIX }]; const updates = [];
  request.pages.forEach((pageNumber) => { const page = sourceState.pages[pageNumber - 1]; const resources = new Map(page.value.get('Resources').entries); const oldFonts = resources.get('Font'); const fonts = new Map(oldFonts?.entries ?? []); fonts.set(FONT_NAME, font); resources.set('Font', dict(fonts)); const bytes = stream(page, request.header, request.footerPrefix); const content = pendingClassicObjectReference(`content-${pageNumber}`); additions.push({ id: `content-${pageNumber}`, value: dict([['Length', num(bytes.length)]]), streamBytes: bytes }); const value = new Map(page.value); value.set('Resources', dict(resources)); value.set('Contents', array([prefix, page.value.get('Contents'), suffix, content])); updates.push({ reference: page.ref, value: dict(value) }); });
  const transaction = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: sourceState.structure, updates, additions, info: { kind: 'preserve' }, changingId: null }); return Object.freeze({ bytes: Buffer.concat([source, transaction.revision.bytes]), state: sourceState });
}
function verify(source, output, request, sourceState = state(source, request)) {
  if (!Buffer.isBuffer(output) || output.length <= source.length || !output.subarray(0, source.length).equals(source)) invalidOutput('Source prefix was not preserved.'); let parsed; try { parsed = parseClassicPdfStructure(output); } catch { invalidOutput(); }
  if (parsed.revisions.length !== 2 || parsed.revisions.some((revision) => revision.xrefKind && revision.xrefKind !== 'classic') || !same(parsed.root, sourceState.structure.root)) invalidOutput('Unexpected output revision.');
  const trailer = parsed.revisions[0].trailer;
  const expectedFinalSize = sourceState.structure.finalSize + request.pages.length + 3;
  if (parsed.info !== null || parsed.id !== null || parsed.finalSize !== expectedFinalSize
    || JSON.stringify([...trailer.keys()].sort()) !== JSON.stringify(['Prev', 'Root', 'Size'])
    || trailer.get('Size')?.type !== 'number' || !trailer.get('Size').integer || trailer.get('Size').value !== expectedFinalSize
    || !same(trailer.get('Root'), sourceState.structure.root)
    || trailer.get('Prev')?.type !== 'number' || !trailer.get('Prev').integer
    || trailer.get('Prev').value !== sourceState.structure.revisions[0].offset) invalidOutput('Unexpected output trailer.');
  const catalog = pdfDictionary(resolveClassicPdfObject(parsed, parsed.root).value); const pagesRef = catalog.get('Pages'); const pagesValue = pagesRef?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(parsed, pagesRef).value) : null; const kids = pagesValue?.get('Kids'); if (!pagesValue || kids?.type !== 'array' || kids.values.length !== sourceState.pages.length) invalidOutput('Page tree changed.');
  const selected = new Set(request.pages);
  const sourceObjects = new Set(sourceState.structure.effective.keys());
  const outputObjects = new Set(parsed.effective.keys());
  const added = [...outputObjects].filter((object) => !sourceObjects.has(object));
  const streams = new Set(); let sharedFont = null; let sharedPrefix = null; let sharedSuffix = null; const effects = [];
  for (let index = 0; index < sourceState.pages.length; index += 1) { const sourcePage = sourceState.pages[index]; const currentRef = kids.values[index]; const current = currentRef?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(parsed, currentRef).value) : null; if (!current || !same(currentRef, sourcePage.ref)) invalidOutput('Page topology changed.'); if (!selected.has(sourcePage.page)) { if (!equal(current, sourcePage.value)) invalidOutput('An unselected page changed.'); continue; }
    for (const [key, value] of sourcePage.value) if (key !== 'Resources' && key !== 'Contents' && !equal(value, current.get(key))) invalidOutput('A preserved page entry changed.'); const resources = current.get('Resources'); const sourceResources = sourcePage.value.get('Resources'); const contents = current.get('Contents'); if (resources?.type !== 'dict' || contents?.type !== 'array' || contents.values.length !== 4 || !equal(contents.values[1], sourcePage.value.get('Contents'))) invalidOutput('Selected page topology is invalid.');
    for (const [key, value] of sourceResources.entries) if (key !== 'Font' && !equal(resources.entries.get(key), value)) invalidOutput('Original resources changed.');
    const fonts = resources.entries.get('Font');
    const sourceFonts = sourceResources.entries.get('Font');
    const fontRef = fonts?.type === 'dict' ? fonts.entries.get(FONT_NAME) : null;
    const font = fontRef?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(parsed, fontRef).value) : null;
    if (fontRef?.type !== 'ref' || !font || font.size !== 4 || font.get('Type')?.value !== 'Font' || font.get('Subtype')?.value !== 'Type1' || font.get('BaseFont')?.value !== 'Courier' || font.get('Encoding')?.value !== 'WinAnsiEncoding') invalidOutput('Header/footer font is invalid.');
    const expectedResourceKeys = [...new Set([...sourceResources.entries.keys(), 'Font'])].sort();
    if (JSON.stringify([...resources.entries.keys()].sort()) !== JSON.stringify(expectedResourceKeys)) invalidOutput('Header/footer resource topology changed.');
    const expectedFontKeys = [...new Set([...(sourceFonts?.entries.keys() ?? []), FONT_NAME])].sort();
    if (fonts?.type !== 'dict' || JSON.stringify([...fonts.entries.keys()].sort()) !== JSON.stringify(expectedFontKeys)) invalidOutput('Header/footer font-resource topology changed.');
    if (sourceFonts?.type === 'dict') for (const [key, value] of sourceFonts.entries) if (!equal(fonts.entries.get(key), value)) invalidOutput('Original font resources changed.');
    if (sharedFont && !same(sharedFont, fontRef)) invalidOutput('Header/footer font was not shared.');
    sharedFont = fontRef;
    const prefixRef = contents.values[0]; const suffixRef = contents.values[2]; const streamRef = contents.values[3];
    const prefix = prefixRef?.type === 'ref' ? resolveClassicPdfObject(parsed, prefixRef) : null;
    const suffix = suffixRef?.type === 'ref' ? resolveClassicPdfObject(parsed, suffixRef) : null;
    if (!prefix?.stream || prefix.streamLength !== ISOLATION_PREFIX.length || !output.subarray(prefix.streamStart, prefix.streamStart + prefix.streamLength).equals(ISOLATION_PREFIX)
      || !suffix?.stream || suffix.streamLength !== ISOLATION_SUFFIX.length || !output.subarray(suffix.streamStart, suffix.streamStart + suffix.streamLength).equals(ISOLATION_SUFFIX)) invalidOutput('Header/footer source-content isolation is invalid.');
    if (sharedPrefix && !same(sharedPrefix, prefixRef) || sharedSuffix && !same(sharedSuffix, suffixRef)) invalidOutput('Header/footer source-content isolation was not shared.');
    sharedPrefix = prefixRef; sharedSuffix = suffixRef;
    const content = streamRef?.type === 'ref' ? resolveClassicPdfObject(parsed, streamRef) : null; const expected = stream(sourcePage, request.header, request.footerPrefix); if (streamRef?.type !== 'ref' || streams.has(streamRef.object) || !content?.stream || content.streamLength !== expected.length || !output.subarray(content.streamStart, content.streamStart + content.streamLength).equals(expected)) invalidOutput('Header/footer effect stream is invalid.'); streams.add(streamRef.object); effects.push(Object.freeze({ page: sourcePage.page, applied: true }));
  }
  const expectedAdded = new Set([sharedFont?.object, sharedPrefix?.object, sharedSuffix?.object, ...streams].filter(Number.isSafeInteger));
  const expectedChanged = new Map([
    ...sourceState.pages.filter((page) => selected.has(page.page)).map((page) => [page.ref.object, page.ref.generation]),
    ...[...expectedAdded].map((object) => [object, 0]),
  ]);
  const latestEntries = parsed.revisions[0].entries;
  const latestObjects = new Set();
  const latestInvalid = latestEntries.some((entry) => {
    if (entry.status !== 'n' || expectedChanged.get(entry.object) !== entry.generation || latestObjects.has(entry.object)) return true;
    latestObjects.add(entry.object);
    return false;
  });
  if (added.length !== expectedAdded.size || added.some((object) => !expectedAdded.has(object))
    || latestEntries.length !== expectedChanged.size || latestInvalid || latestObjects.size !== expectedChanged.size) {
    invalidOutput('Unexpected incremental objects were written.');
  }
  return Object.freeze({ profile: PDF_PAGE_HEADER_FOOTER_PROFILE, sourceSha256: digest(source), outputSha256: digest(output), pageCount: sourceState.pages.length, pages: Object.freeze(effects), sourcePrefixPreserved: true, revisionCount: 2, appearance: PDF_PAGE_HEADER_FOOTER_APPEARANCE });
}
export function writePdfPageHeaderFooter(source, value) { const request = normalizePdfPageHeaderFooter(value); const built = build(source, request); return Object.freeze({ bytes: built.bytes, proof: verify(source, built.bytes, request, built.state) }); }
export function inspectPdfPageHeaderFooter(source, output, value) { const request = normalizePdfPageHeaderFooter(value); return verify(source, output, request); }
