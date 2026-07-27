import { createHash } from 'node:crypto';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { normalizePdfAcroFormBarcodeRequest, PDF_ACROFORM_BARCODE_LIMITS, PDF_ACROFORM_BARCODE_PROFILE } from './pdf-acroform-barcode-contract.mjs';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const PREPARED = new WeakMap();
const PATTERNS = Object.freeze({
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn',
  G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww',
  M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn',
  S: 'nnwnnnwwn', T: 'nnnnwnwwn', U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw',
  Y: 'wwnnwnnnn', Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn',
  '$': 'nwnwnwnnn', '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
});

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function unsupported(message = 'The source PDF is outside the supported passive barcode-field subset.') { fail('UNSUPPORTED_PDF_ACROFORM_BARCODE_SOURCE', message); }
function invalid(message = 'The AcroForm barcode request is invalid.') { fail('INVALID_PDF_ACROFORM_BARCODE', message); }
function outputInvalid() { fail('INVALID_PDF_ACROFORM_BARCODE_OUTPUT', 'The barcode-field output failed deterministic verification.'); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function number(value, raw = undefined) { return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), ...(raw === undefined ? {} : { raw }) }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function sameRef(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function formatNumber(value) { const rounded = Math.round(value * 1_000_000) / 1_000_000; if (!Number.isFinite(rounded) || Math.abs(rounded) > PDF_ACROFORM_BARCODE_LIMITS.maxCoordinate) invalid('Barcode geometry is outside the bounded range.'); return Object.is(rounded, -0) ? '0' : String(rounded); }
function numericArray(value, field) { if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((item) => item?.type !== 'number' || !Number.isFinite(item.value))) unsupported(`${field} must be a direct four-number array.`); return value.values.map((item) => item.value); }
function pageBox(value, field) { const [left, bottom, right, top] = numericArray(value, field); if (!(right > left && top > bottom) || [left, bottom, right, top].some((item) => Math.abs(item) > PDF_ACROFORM_BARCODE_LIMITS.maxCoordinate)) unsupported(`${field} is malformed.`); return Object.freeze({ left, bottom, right, top }); }
function inside(box, value) { return value.x >= box.left && value.y >= box.bottom && value.x + value.width <= box.right && value.y + value.height <= box.top; }

function barcodeAppearance(rect, payload) {
  const symbols = `*${payload}*`; const moduleCount = symbols.length * 15 + symbols.length - 1 + 20; const moduleWidth = rect.width / moduleCount;
  if (!Number.isFinite(moduleWidth) || moduleWidth < 0.1) invalid('rect is too narrow for the bounded barcode payload.');
  let cursor = 10; const commands = ['q', '0 g'];
  for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
    const pattern = PATTERNS[symbols[symbolIndex]]; if (!pattern) invalid('payload contains an unsupported Code 39 character.');
    for (let index = 0; index < pattern.length; index += 1) {
      const units = pattern[index] === 'w' ? 3 : 1;
      if (index % 2 === 0) commands.push(`${formatNumber(cursor * moduleWidth)} 0 ${formatNumber(units * moduleWidth)} ${formatNumber(rect.height)} re f`);
      cursor += units;
    }
    if (symbolIndex + 1 < symbols.length) cursor += 1;
  }
  commands.push('Q', '');
  return Object.freeze({ bytes: Buffer.from(commands.join('\n'), 'latin1'), moduleCount, moduleWidth });
}
function appearanceForm(appearance, rect) { return { value: dict([['Type', name('XObject')], ['Subtype', name('Form')], ['FormType', number(1)], ['BBox', array([number(0), number(0), number(rect.width, formatNumber(rect.width)), number(rect.height, formatNumber(rect.height))])]]), streamBytes: appearance.bytes }; }

const FORBIDDEN = new Set(['AcroForm', 'Annots', 'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'StructTreeRoot', 'MarkInfo', 'OCProperties', 'Metadata', 'AF', 'Names', 'Perms', 'Outlines', 'PieceInfo', 'Collection', 'OutputIntents', 'XFA', 'Tabs', 'OC', 'Layer', 'Group', 'URI', 'Dest', 'GoTo', 'Launch', 'SubmitForm', 'ResetForm', 'NeedAppearances', 'CO', 'DR', 'ByteRange', 'SubFilter', 'Cert', 'Reference', 'TransformMethod', 'RoleMap', 'ParentTree']);
function rejectActive(value, context) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'dict') {
    for (const key of value.entries.keys()) if (FORBIDDEN.has(key)) unsupported(`${context} contains unsupported interactive, tagged, or layered content.`);
    if (value.entries.get('Subtype')?.value === 'Widget' || value.entries.get('Type')?.value === 'Sig' || value.entries.get('FT')?.value === 'Sig') unsupported('Existing widgets or signatures are not admitted.');
    for (const [key, child] of value.entries) rejectActive(child, `${context}.${key}`);
  } else if (value.type === 'array') for (const child of value.values) rejectActive(child, context);
}

function admit(source) {
  if (source.length < 32 || source.length > MAX_SOURCE_BYTES) unsupported('Source size is outside the bounded range.');
  if (source.includes(Buffer.from('/Encrypt', 'latin1'))) unsupported('Encrypted PDFs are not admitted.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported('Only valid classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1 || structure.revisions.some((revision) => revision.xrefKind === 'stream') || structure.id || structure.info) unsupported('Only one classic revision without IDs or Info is admitted.');
  const catalogObject = resolveClassicPdfObject(structure, structure.root); const catalog = pdfDictionary(catalogObject.value);
  if (catalogObject.stream || catalog.get('Type')?.value !== 'Catalog' || catalog.size !== 2 || catalog.get('Pages')?.type !== 'ref') unsupported('Catalog must be a direct Catalog/Pages pair.');
  rejectActive(catalogObject.value, 'catalog');
  const seen = new Set(); const pages = []; const details = new Map();
  function mark(reference) { const key = `${reference.object}:${reference.generation}`; if (seen.has(key)) unsupported('Aliased page, content, or resource references are not admitted.'); seen.add(key); }
  function markNestedRefs(value) { if (!value || typeof value !== 'object') return; if (value.type === 'ref') { mark(value); return; } if (value.type === 'dict') for (const child of value.entries.values()) markNestedRefs(child); else if (value.type === 'array') for (const child of value.values) markNestedRefs(child); }
  function walk(reference, kind, parent = null) {
    mark(reference); const object = resolveClassicPdfObject(structure, reference);
    if (object.stream) { if (kind !== 'content') unsupported('Only page content streams may be streams.'); return; }
    const value = pdfDictionary(object.value); rejectActive(object.value, `${kind} object`);
    if (kind === 'pages') {
      if (value.get('Type')?.value !== 'Pages' || value.get('Kids')?.type !== 'array' || value.get('Count')?.type !== 'number' || value.get('Count').value < 0 || [...value.keys()].some((key) => !['Type', 'Kids', 'Count'].includes(key))) unsupported('Pages tree is not direct and bounded.');
      for (const child of value.get('Kids').values) { if (child.type !== 'ref') unsupported('Page Kids must be references.'); const childValue = pdfDictionary(resolveClassicPdfObject(structure, child).value); if (childValue.get('Type')?.value !== 'Page') unsupported('Only a flat direct Pages tree is admitted.'); walk(child, 'page', reference); }
      return;
    }
    const allowed = new Set(['Type', 'Parent', 'MediaBox', 'CropBox', 'Resources', 'Contents']);
    if (kind !== 'page' || value.get('Type')?.value !== 'Page' || value.get('Parent')?.type !== 'ref' || !sameRef(value.get('Parent'), parent) || [...value.keys()].some((key) => !allowed.has(key))) unsupported('Page must be direct with no inherited or interactive entries.');
    const media = pageBox(value.get('MediaBox'), 'MediaBox'); const crop = value.has('CropBox') ? pageBox(value.get('CropBox'), 'CropBox') : media;
    if (value.get('Resources')?.type !== 'dict') unsupported('Page Resources must be a direct dictionary.');
    const contents = value.get('Contents'); if (contents?.type === 'ref') walk(contents, 'content'); else if (contents?.type === 'array') for (const child of contents.values) { if (child.type !== 'ref') unsupported('Page Contents must be references.'); walk(child, 'content'); } else if (contents !== undefined) unsupported('Page Contents must be a reference or array.');
    rejectActive(value.get('Resources'), 'page resources'); markNestedRefs(value.get('Resources')); pages.push(reference); details.set(`${reference.object}:${reference.generation}`, Object.freeze({ crop }));
  }
  walk(catalog.get('Pages'), 'pages');
  const declared = pdfDictionary(resolveClassicPdfObject(structure, catalog.get('Pages')).value).get('Count').value;
  if (pages.length < 1 || pages.length > PDF_ACROFORM_BARCODE_LIMITS.maxPages || pages.length !== declared) unsupported('Page count is inconsistent or outside bounds.');
  for (const entry of structure.effective.values()) if (entry.status === 'n') { const object = resolveClassicPdfObject(structure, { type: 'ref', object: entry.object, generation: entry.generation }); rejectActive(object.value, `object ${entry.object}`); const value = object.value?.type === 'dict' ? pdfDictionary(object.value) : null; if (value?.has('T') || value?.has('FT') || value?.get('Subtype')?.value === 'Widget') unsupported('Existing form fields or widgets are not admitted.'); }
  return Object.freeze({ structure, pages, details });
}

function build(source, request, admission) {
  const page = admission.pages[request.page - 1]; if (!page) invalid('page is outside the direct Pages tree.');
  if (!inside(admission.details.get(`${page.object}:${page.generation}`).crop, request.rect)) invalid('rect must be fully contained by the page CropBox.');
  const appearance = barcodeAppearance(request.rect, request.payload); const form = appearanceForm(appearance, request.rect);
  const appearanceRef = pendingClassicObjectReference('appearance'); const widgetRef = pendingClassicObjectReference('widget'); const acroRef = pendingClassicObjectReference('acro');
  const rect = request.rect; const widget = dict([
    ['Type', name('Annot')], ['Subtype', name('Widget')], ['FT', name('Tx')], ['F', number(4)], ['Ff', number(1)],
    ['T', pdfUtf16BeString(request.fieldName)], ['TU', pdfUtf16BeString('Passive Code 39 barcode')],
    ['Rect', array([number(rect.x, formatNumber(rect.x)), number(rect.y, formatNumber(rect.y)), number(rect.x + rect.width, formatNumber(rect.x + rect.width)), number(rect.y + rect.height, formatNumber(rect.y + rect.height))])],
    ['V', pdfUtf16BeString(request.payload)], ['DV', pdfUtf16BeString(request.payload)], ['MaxLen', number(request.payload.length)],
    ['AP', dict([['N', appearanceRef]])], ['P', page],
  ]);
  const acro = dict([['Fields', array([widgetRef])]]);
  const catalogObject = resolveClassicPdfObject(admission.structure, admission.structure.root); const catalogEntries = new Map(pdfDictionary(catalogObject.value)); catalogEntries.set('AcroForm', acroRef);
  const pageObject = resolveClassicPdfObject(admission.structure, page); const pageEntries = new Map(pdfDictionary(pageObject.value)); pageEntries.set('Annots', array([widgetRef]));
  let transaction; try { transaction = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: admission.structure, updates: [{ reference: admission.structure.root, value: dict(catalogEntries) }, { reference: page, value: dict(pageEntries) }], additions: [{ id: 'appearance', value: form.value, streamBytes: form.streamBytes }, { id: 'widget', value: widget }, { id: 'acro', value: acro }], info: { kind: 'preserve' }, changingId: null }); } catch { unsupported('The barcode-field revision could not be planned.'); }
  const bytes = Buffer.concat([source, transaction.revision.bytes]); const references = Object.freeze({ appearance: transaction.referencesById.appearance, widget: transaction.referencesById.widget, acroForm: transaction.referencesById.acro });
  const proof = Object.freeze({ profile: PDF_ACROFORM_BARCODE_PROFILE, sourceSha256: request.sourceSha256, page: request.page, fieldNameSha256: digest(Buffer.from(request.fieldName, 'utf8')), payloadSha256: digest(Buffer.from(request.payload, 'ascii')), symbology: request.symbology, rect: request.rect, moduleCount: appearance.moduleCount, quietZoneModules: 10, readOnly: true, activeContentAdded: false, sourcePrefixPreserved: true, addedObjectCount: 3, changedObjectCount: 5, references });
  return Object.freeze({ bytes, proof, state: Object.freeze({ request, page, references, appearanceBytes: appearance.bytes, proof }) });
}

export function preparePdfAcroFormBarcode(sourceBytes, value) {
  if (!Buffer.isBuffer(sourceBytes)) invalid('sourceBytes must be a Buffer.'); const source = Buffer.from(sourceBytes);
  let request; try { request = normalizePdfAcroFormBarcodeRequest(value); } catch (error) { if (error?.code === 'INVALID_PDF_ACROFORM_BARCODE') throw error; invalid(); }
  if (digest(source) !== request.sourceSha256) invalid('sourceSha256 does not match source bytes.');
  const built = build(source, request, admit(source)); const result = Object.freeze({ bytes: built.bytes, proof: built.proof }); PREPARED.set(result, Object.freeze({ ...built.state, result })); return result;
}

export function inspectPdfAcroFormBarcode(sourceBytes, outputBytes, value) {
  const prepared = preparePdfAcroFormBarcode(sourceBytes, value); const state = PREPARED.get(prepared);
  if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(prepared.bytes) || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) outputInvalid();
  let structure; try { structure = parseClassicPdfStructure(outputBytes); } catch { outputInvalid(); }
  if (structure.revisions.length !== 2) outputInvalid();
  const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value); if (catalog.size !== 3 || !sameRef(catalog.get('AcroForm'), state.references.acroForm)) outputInvalid();
  const acro = pdfDictionary(resolveClassicPdfObject(structure, state.references.acroForm).value); if (acro.size !== 1 || acro.get('Fields')?.type !== 'array' || acro.get('Fields').values.length !== 1 || !sameRef(acro.get('Fields').values[0], state.references.widget)) outputInvalid();
  const page = pdfDictionary(resolveClassicPdfObject(structure, state.page).value); if (page.get('Annots')?.type !== 'array' || page.get('Annots').values.length !== 1 || !sameRef(page.get('Annots').values[0], state.references.widget)) outputInvalid();
  const widget = pdfDictionary(resolveClassicPdfObject(structure, state.references.widget).value); const expectedRect = [state.request.rect.x, state.request.rect.y, state.request.rect.x + state.request.rect.width, state.request.rect.y + state.request.rect.height]; const expectedText = pdfUtf16BeString(state.request.payload).bytes;
  if (widget.size !== 13 || widget.get('Type')?.value !== 'Annot' || widget.get('Subtype')?.value !== 'Widget' || widget.get('FT')?.value !== 'Tx' || widget.get('F')?.value !== 4 || widget.get('Ff')?.value !== 1 || widget.get('MaxLen')?.value !== state.request.payload.length || !sameRef(widget.get('P'), state.page) || widget.get('Rect')?.type !== 'array' || widget.get('Rect').values.some((item, index) => item?.value !== expectedRect[index]) || !widget.get('V')?.bytes?.equals(expectedText) || !widget.get('DV')?.bytes?.equals(expectedText) || !widget.get('T')?.bytes?.equals(pdfUtf16BeString(state.request.fieldName).bytes) || !widget.get('TU')?.bytes?.equals(pdfUtf16BeString('Passive Code 39 barcode').bytes) || widget.get('AP')?.type !== 'dict' || widget.get('AP').entries.size !== 1 || !sameRef(widget.get('AP').entries.get('N'), state.references.appearance)) outputInvalid();
  const appearance = resolveClassicPdfObject(structure, state.references.appearance); const appearanceValue = pdfDictionary(appearance.value); const bytes = appearance.stream && structure.buffer.subarray(appearance.streamStart, appearance.streamStart + appearance.streamLength); const expectedBox = [0, 0, state.request.rect.width, state.request.rect.height];
  if (!bytes?.equals(state.appearanceBytes) || appearanceValue.size !== 5 || appearanceValue.get('Type')?.value !== 'XObject' || appearanceValue.get('Subtype')?.value !== 'Form' || appearanceValue.get('FormType')?.value !== 1 || appearanceValue.get('Length')?.value !== state.appearanceBytes.length || appearanceValue.has('Resources') || appearanceValue.get('BBox')?.type !== 'array' || appearanceValue.get('BBox').values.some((item, index) => item?.value !== expectedBox[index])) outputInvalid();
  return Object.freeze({ ...state.proof, otherPagesContentResourcesPreserved: true });
}

export const writePdfAcroFormBarcode = preparePdfAcroFormBarcode;
export const verifyPdfAcroFormBarcode = inspectPdfAcroFormBarcode;
