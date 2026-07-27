import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { normalizePdfBatesNumbering, PDF_BATES_NUMBERING_PROFILE } from './pdf-bates-numbering-contract.mjs';
export { PDF_BATES_NUMBERING_PROFILE };
const MAX_BYTES = 32 * 1024 * 1024;
// WinAnsi Helvetica has glyph advances below 1.1 em; 1.2 em is a bounded
// upper estimate for every admitted printable ASCII glyph and avoids clipping.
const HELVETICA_SAFE_WIDTH_EM = 1.2;
const UNSAFE = new Set(['AcroForm', 'Annots', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'Outlines', 'XFA', 'ByteRange', 'Sig', 'Tabs', 'PieceInfo', 'Collection', 'Dests', 'Dest', 'GoTo', 'GoToR', 'Launch', 'SubmitForm', 'ImportData', 'RichMedia', '3D', 'Threads', 'ViewerPreferences', 'Lang', 'OutputIntents', 'Requirements', 'Legal', 'SpiderInfo', 'TrapNet', 'RoleMap', 'ParentTree', 'ActualText', 'Alt', 'E', 'AP', 'AS', 'OC']);
function error(code, message) { const e = new Error(message);
e.code = code;
throw e;
}
function unsupported(message = 'The source is outside the passive Bates-numbering subset.') { error('UNSUPPORTED_PDF_BATES_NUMBERING_SOURCE', message);
}
function invalidOutput() { error('INVALID_PDF_BATES_NUMBERING_OUTPUT', 'Bates-numbering output verification failed.');
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex');
}
function same(a, b) { return a?.object === b?.object && a?.generation === b?.generation;
}
function name(value) { return Object.freeze({ type: 'name', value });
} function number(value, raw = String(value)) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw });
} function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) });
} function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) });
} function str(bytes) { return Object.freeze({ type: 'string', bytes: Buffer.from(bytes) });
}
function textBytes(value) { return Buffer.from(value, 'latin1'); }
function hex(bytes) { return `<${bytes.toString('hex').toUpperCase()}>`;
}
function reject(value, structure, seen = new Set()) { if (!value || typeof value !== 'object') return;
if (value.type === 'ref') { const key = `${value.object}:${value.generation}`; if (seen.has(key)) return; seen.add(key); reject(resolveClassicPdfObject(structure, value).value, structure, seen); return; }
if (value.type === 'dict') { for (const [key, child] of value.entries) { if (UNSAFE.has(key) || key === 'FT') unsupported(); reject(child, structure, seen); } } else if (value.type === 'array') value.values.forEach((child) => reject(child, structure, seen));
}
function rejectResourceAliases(value) { if (!value || typeof value !== 'object') return;
if (value.type === 'ref') unsupported('Indirect nested resource aliases are outside the passive subset.');
if (value.type === 'dict') for (const child of value.entries.values()) rejectResourceAliases(child);
if (value.type === 'array') value.values.forEach(rejectResourceAliases);
}
function box(value) { if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((x) => x?.type !== 'number' || !Number.isFinite(x.value))) unsupported();
const b = value.values.map((x) => x.value);
if (!(b[2] > b[0] && b[3] > b[1])) unsupported();
return b;
}
function pageState(source, request) { if (!Buffer.isBuffer(source) || source.length < 32 || source.length > MAX_BYTES || digest(source) !== request.sourceSha256) error('INVALID_PDF_BATES_NUMBERING', 'Source digest mismatch.');
const trailerWindow = source.subarray(Math.max(0, source.lastIndexOf(Buffer.from('trailer')))).toString('latin1'); if (/\btrailer\s*<<[\s\S]*?\/Encrypt(?:\s|\/|>)/u.test(trailerWindow)) unsupported('Encrypted sources are outside the passive Bates-numbering subset.');
let s;
try { s = parseClassicPdfStructure(source);
} catch { unsupported();
} if (s.revisions.length !== 1 || s.revisions[0].xrefKind === 'stream' || s.id || s.info) unsupported('Only one classic revision without IDs or Info is supported.');
for (const entry of s.effective.values()) { if (entry.status === 'n') reject({ type: 'ref', object: entry.object, generation: entry.generation }, s);
} const catalog = pdfDictionary(resolveClassicPdfObject(s, s.root).value);
const pagesRef = catalog.get('Pages');
if (catalog.size !== 2 || catalog.get('Type')?.value !== 'Catalog' || pagesRef?.type !== 'ref') unsupported();
const pagesObj = pdfDictionary(resolveClassicPdfObject(s, pagesRef).value);
const kids = pagesObj.get('Kids');
if (pagesObj.get('Type')?.value !== 'Pages' || pagesObj.get('Count')?.value !== kids?.values.length || !kids || kids.type !== 'array' || kids.values.length < 1 || kids.values.length > 500) unsupported();
const pageRefs = new Set(); const contentRefs = new Set();
const pages = kids.values.map((r) => { if (r.type !== 'ref') unsupported(); const pageKey = `${r.object}:${r.generation}`; if (pageRefs.has(pageKey)) unsupported('Page references must be unique.'); pageRefs.add(pageKey);
const value = pdfDictionary(resolveClassicPdfObject(s, r).value);
const resources = value.get('Resources');
if (value.get('Type')?.value !== 'Page' || !same(value.get('Parent'), pagesRef) || resources?.type !== 'dict' || value.get('Contents')?.type !== 'ref' || value.has('Annots')) unsupported();
for (const [resourceKey, resourceValue] of resources.entries) if (resourceKey !== 'Font') rejectResourceAliases(resourceValue);
if (resources.entries.has('Font') && resources.get('Font')?.type !== 'dict') unsupported('The existing Font resource must be a direct dictionary.');
if (resources.entries.get('Font')?.type === 'dict' && resources.entries.get('Font').entries.has('BatesHelv')) unsupported('Dedicated Bates resource name collides with an existing font.');
const contentKey = `${value.get('Contents').object}:${value.get('Contents').generation}`; if (contentRefs.has(contentKey)) unsupported('Content streams must not be aliased across pages.'); contentRefs.add(contentKey);
const media = box(value.get('MediaBox'));
const crop = box(value.get('CropBox'));
const content = resolveClassicPdfObject(s, value.get('Contents'));
if (!content.stream) unsupported();
reject(content.value, s);
return Object.freeze({ ref: r, value, media, crop, content });
});
request.pages.forEach((p) => { if (!pages[p - 1]) error('INVALID_PDF_BATES_NUMBERING', 'Selected page is outside the document.');
});
return Object.freeze({ structure: s, pages });
}
function numberText(request, index) { const value = String(request.start + index).padStart(request.padding, '0');
return `${request.prefix}${value}${request.suffix}`;
}
function position(request, crop, content) { const width = Math.max(0, [...content].length * request.fontSize * HELVETICA_SAFE_WIDTH_EM);
const x = request.position.endsWith('left') ? crop[0] + request.margin : request.position.endsWith('right') ? crop[2] - request.margin - width : (crop[0] + crop[2] - width) / 2;
const y = request.position.startsWith('top') ? crop[3] - request.margin - request.fontSize : crop[1] + request.margin;
if (x < crop[0] || y < crop[1] || x + width > crop[2] || y + request.fontSize > crop[3]) error('INVALID_PDF_BATES_NUMBERING', 'Bates number does not fit the selected page box.');
return `${x.toFixed(4)} ${y.toFixed(4)} Td ${hex(textBytes(content))} Tj`;
}
function writeContent(request, crop, index, fontName) { const content = numberText(request, index);
return Buffer.from(`q\nBT\n/${fontName} ${request.fontSize} Tf\n${position(request, crop, content)}\nET\nQ\n`, 'latin1');
}
function canonical(value) { if (value === null || value === undefined) return value;
if (Buffer.isBuffer(value)) return `buffer:${value.toString('hex')}`;
if (value.type === 'ref') return `ref:${value.object}:${value.generation}`;
if (value.type === 'name' || value.type === 'number') return `${value.type}:${value.raw ?? value.value}`;
if (value.type === 'string') return `string:${Buffer.from(value.bytes).toString('hex')}`;
if (value.type === 'array') return ['array', ...value.values.map(canonical)];
if (value.type === 'dict') return ['dict', ...[...value.entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])];
return String(value);
}
function equalValue(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
export function writePdfBatesNumbering(sourceBytes, requestValue) { const request = normalizePdfBatesNumbering(requestValue);
const state = pageState(sourceBytes, request);
const fontName = 'BatesHelv';
const font = pendingClassicObjectReference('font');
const additions = [{ id: 'font', value: dict([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')], ['Encoding', name('WinAnsiEncoding')]]) }];
const updates = [];
const proofs = [];
request.pages.forEach((pageNumber, index) => { const page = state.pages[pageNumber - 1];
const resources = new Map(page.value.get('Resources').entries);
const fonts = resources.get('Font');
if (fonts && fonts.type !== 'dict') unsupported('The existing Font resource must be a direct dictionary.');
const fontEntries = fonts?.type === 'dict' ? new Map(fonts.entries) : new Map();
if (fontEntries.has(fontName)) unsupported('Dedicated Bates resource name collides with an existing font.');
fontEntries.set(fontName, font);
resources.set('Font', dict(fontEntries));
const stream = pendingClassicObjectReference(`content-${pageNumber}`);
additions.push({ id: `content-${pageNumber}`, value: dict([['Length', number(writeContent(request, page.crop, index, fontName).length)]]), streamBytes: writeContent(request, page.crop, index, fontName) });
const pageValue = new Map(page.value);
pageValue.set('Resources', dict(resources));
pageValue.set('Contents', array([page.value.get('Contents'), stream]));
updates.push({ reference: page.ref, value: dict(pageValue) });
proofs.push(Object.freeze({ page: pageNumber, text: numberText(request, index), stream, crop: page.crop }));
});
const tx = planClassicObjectTransaction({ sourceBytes, sourceStructure: state.structure, updates, additions, info: { kind: 'preserve' }, changingId: null });
const bytes = Buffer.concat([sourceBytes, tx.revision.bytes]);
const proof = Object.freeze({ profile: PDF_BATES_NUMBERING_PROFILE, sourceSha256: request.sourceSha256, outputSha256: digest(bytes), pageCount: state.pages.length, pages: Object.freeze(proofs), sourcePrefixPreserved: true, revisionCount: 2, resourceName: fontName, font: tx.referencesById.font });
return Object.freeze({ bytes, proof });
}
export function inspectPdfBatesNumbering(sourceBytes, outputBytes, requestValue) {
 const request = normalizePdfBatesNumbering(requestValue);
 const state = pageState(sourceBytes, request);
 if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) invalidOutput();
 let output;
 try { output = parseClassicPdfStructure(outputBytes); } catch { invalidOutput(); }
 if (output.revisions.length !== 2 || output.revisions.some((revision) => revision.xrefKind && revision.xrefKind !== 'classic') || !same(output.root, state.structure.root)) invalidOutput();
 const catalog = pdfDictionary(resolveClassicPdfObject(output, output.root).value);
 const pagesRef = catalog.get('Pages'); const pagesValue = pagesRef?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(output, pagesRef).value) : null;
 const kids = pagesValue?.get('Kids'); if (!pagesValue || pagesValue.get('Type')?.value !== 'Pages' || kids?.type !== 'array' || kids.values.length !== state.pages.length) invalidOutput();
 const selected = new Map(request.pages.map((page, index) => [page, index])); const sourceObjectNumbers = new Set([...state.structure.effective.keys()]);
 const latestEntries = output.revisions[0].entries.filter((entry) => entry.status === 'n'); const outputObjectNumbers = new Set([...output.effective.keys()]);
 const addedObjectNumbers = [...outputObjectNumbers].filter((object) => !sourceObjectNumbers.has(object));
 const pages = []; let sharedFontRef = null; let sharedFontValue = null; const streamNumbers = new Set();
 for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex += 1) {
   const page = pageIndex + 1; const sourcePage = state.pages[pageIndex]; const pageRef = kids.values[pageIndex]; const pageValue = pageRef?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(output, pageRef).value) : null;
   if (pageRef?.type !== 'ref' || !same(pageRef, sourcePage.ref) || !pageValue || pageValue.size !== sourcePage.value.size || pageValue.get('Type')?.value !== 'Page') invalidOutput();
   const sourceResources = sourcePage.value.get('Resources'); const resources = pageValue.get('Resources'); if (resources?.type !== 'dict' || sourceResources?.type !== 'dict') invalidOutput();
   const sourceContents = sourcePage.value.get('Contents'); const contents = pageValue.get('Contents'); const index = selected.get(page);
   if (index === undefined) { if (!equalValue(pageValue, sourcePage.value)) invalidOutput(); continue; }
   const sourcePageKeys = [...sourcePage.value.keys()].sort(); const outputPageKeys = [...pageValue.keys()].sort();
   if (JSON.stringify(sourcePageKeys) !== JSON.stringify(outputPageKeys)) invalidOutput();
   for (const key of sourcePageKeys) if (key !== 'Contents' && key !== 'Resources' && !equalValue(pageValue.get(key), sourcePage.value.get(key))) invalidOutput();
   if (contents?.type !== 'array' || contents.values.length !== 2 || !equalValue(contents.values[0], sourceContents)) invalidOutput();
   const fonts = resources.entries.get('Font'); const sourceFonts = sourceResources.entries.get('Font'); const fontRef = fonts?.type === 'dict' ? fonts.entries.get('BatesHelv') : null;
   const fontValue = fontRef?.type === 'ref' ? pdfDictionary(resolveClassicPdfObject(output, fontRef).value) : null;
   if (fonts?.type !== 'dict' || sourceFonts?.type === 'ref' || fontRef?.type !== 'ref' || !fontValue || fontValue.size !== 4
     || fontValue.get('Type')?.value !== 'Font' || fontValue.get('Subtype')?.value !== 'Type1' || fontValue.get('BaseFont')?.value !== 'Helvetica'
     || fontValue.get('Encoding')?.value !== 'WinAnsiEncoding') invalidOutput();
   const sourceResourceKeys = [...sourceResources.entries.keys()].sort(); const resourceKeys = [...resources.entries.keys()].sort();
   if (JSON.stringify(resourceKeys) !== JSON.stringify([...new Set([...sourceResourceKeys, 'Font'])].sort())) invalidOutput();
   for (const [key, value] of sourceResources.entries) if (key !== 'Font' && !equalValue(resources.entries.get(key), value)) invalidOutput();
   if (sourceFonts?.type === 'dict') for (const [key, value] of sourceFonts.entries) if (!equalValue(fonts.entries.get(key), value)) invalidOutput();
   if (sharedFontRef && !same(sharedFontRef, fontRef)) invalidOutput(); sharedFontRef = fontRef; sharedFontValue ??= fontValue;
   if (!equalValue(sharedFontValue, fontValue)) invalidOutput();
   const streamRef = contents.values[1]; const stream = streamRef?.type === 'ref' ? resolveClassicPdfObject(output, streamRef) : null; const expected = writeContent(request, sourcePage.crop, index, 'BatesHelv');
   if (streamRef?.type !== 'ref' || streamNumbers.has(streamRef.object) || stream?.stream !== true || stream.streamLength !== expected.length
     || !outputBytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength).equals(expected)) invalidOutput();
   streamNumbers.add(streamRef.object); pages.push(Object.freeze({ page, text: numberText(request, index) }));
 }
 const expectedAdded = new Set([sharedFontRef?.object, ...streamNumbers].filter(Number.isSafeInteger)); const latestNumbers = new Set(latestEntries.map((entry) => entry.object));
 const expectedChanged = new Set([...state.pages.map((page, index) => selected.has(index + 1) ? page.ref.object : null).filter(Number.isSafeInteger), ...expectedAdded]);
 if (addedObjectNumbers.length !== expectedAdded.size || addedObjectNumbers.some((object) => !expectedAdded.has(object))
   || latestNumbers.size !== expectedChanged.size || [...latestNumbers].some((object) => !expectedChanged.has(object))) invalidOutput();
 return Object.freeze({ profile: PDF_BATES_NUMBERING_PROFILE, sourceSha256: request.sourceSha256, outputSha256: digest(outputBytes), pageCount: state.pages.length, pages: Object.freeze(pages), sourcePrefixPreserved: true, revisionCount: output.revisions.length, resourceName: 'BatesHelv' });
}
