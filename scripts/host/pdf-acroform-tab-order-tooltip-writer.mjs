import { createHash } from 'node:crypto';
import { pdfDictionary, serializePdfValue } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';
import {
  normalizePdfAcroFormTabOrderTooltip,
  PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE,
} from './pdf-acroform-tab-order-tooltip-contract.mjs';

export const PDF_ACROFORM_TAB_ORDER_TOOLTIPS_PROFILE = PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE;
export { PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE };
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const ACTIVE_KEYS = new Set([
  'A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'Launch', 'URI', 'SubmitForm', 'ResetForm', 'ImportData',
  'XFA', 'StructTreeRoot', 'StructParents', 'ParentTree', 'RoleMap', 'ClassMap', 'MarkInfo', 'OCProperties',
  'OC', 'OCGs', 'Layer', 'Group', 'Metadata', 'Perms', 'Outlines', 'Names', 'AF', 'EmbeddedFiles',
  'RichMediaContent', '3DD', 'Sound', 'Movie', 'SigFlags', 'ByteRange', 'Reference', 'TransformMethod',
]);
const SIGNATURE_NAMES = new Set(['Sig', 'DocTimeStamp']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function invalid(message = 'The AcroForm tab-order and tooltip request is invalid.') { throw failure('INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP', message); }
function unsupported(message = 'The source PDF is outside the passive AcroForm tab-order and tooltip subset.') { throw failure('UNSUPPORTED_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE', message); }
function outputInvalid(message = 'The tab-order and tooltip output failed deterministic verification.') { throw failure('INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameRef(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function ref(value) { if (value?.type !== 'ref') unsupported('Indirect references are required for page annotations.'); return { type: 'ref', object: value.object, generation: value.generation }; }
function plainReference(value) { return Object.freeze({ object: value.object, generation: value.generation }); }
function name(value) { return Object.freeze({ type: 'name', value }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function fingerprint(sourceSha256, page, annotationIndex, fieldType) {
  return digest(Buffer.from([
    'pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`, `page=${page}`,
    `annotation-index=${annotationIndex}`, 'subtype=widget', `widget-type=${fieldType}`,
  ].join('\n'), 'utf8'));
}
function fieldType(value) {
  const type = value?.type === 'name' ? value.value : null;
  return type === 'Tx' ? 'text' : type === 'Btn' ? 'button' : type === 'Ch' ? 'choice' : type === 'Sig' ? 'signature' : 'unknown';
}
function directDictionary(object, context) { if (object?.stream || object?.value?.type !== 'dict') unsupported(`${context} must be a direct dictionary.`); return pdfDictionary(object.value); }
function resolvedDictionary(structure, reference, context) { return directDictionary(resolveClassicPdfObject(structure, reference), context); }
function walkReferences(value, callback, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'ref') { callback(value, seen); return; }
  if (value.type === 'dict') for (const child of value.entries.values()) walkReferences(child, callback, seen);
  else if (value.type === 'array') for (const child of value.values) walkReferences(child, callback, seen);
}
function rejectActiveValue(value, context, structure, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'dict') {
    for (const [key, child] of value.entries) {
      if (ACTIVE_KEYS.has(key)) unsupported(`${context} contains active content.`);
      if (key === 'Type' && child?.type === 'name' && SIGNATURE_NAMES.has(child.value)) unsupported('Signatures are not admitted.');
      if (key === 'Subtype' && child?.type === 'name' && SIGNATURE_NAMES.has(child.value)) unsupported('Signatures are not admitted.');
      if (key === 'FT' && child?.type === 'name' && child.value === 'Sig') unsupported('Signatures are not admitted.');
      rejectActiveValue(child, `${context}.${key}`, structure, seen);
    }
    return;
  }
  if (value.type === 'array') { for (const child of value.values) rejectActiveValue(child, context, structure, seen); return; }
  if (value.type !== 'ref') return;
  const key = `${value.object}:${value.generation}`; if (seen.has(key)) return; seen.add(key);
  const object = resolveClassicPdfObject(structure, value); if (object.stream) return;
  rejectActiveValue(object.value, `${context}->${key}`, structure, seen);
}
function pageBoxWalk(structure, reference, parent, pages, seen) {
  const key = `${reference.object}:${reference.generation}`; if (seen.has(key)) unsupported('The page tree contains an alias or cycle.'); seen.add(key);
  const entries = resolvedDictionary(structure, reference, 'page tree object'); const type = entries.get('Type')?.value;
  if (type === 'Pages') {
    const kids = entries.get('Kids'); if (kids?.type !== 'array' || kids.values.length < 1 || entries.get('Count')?.type !== 'number' || entries.get('Count').value !== kids.values.length) unsupported('The page tree is not flat and bounded.');
    for (const child of kids.values) { const childRef = ref(child); const childEntries = resolvedDictionary(structure, childRef, 'page tree child'); if (childEntries.get('Parent')?.type !== 'ref' || !sameRef(childEntries.get('Parent'), reference)) unsupported('Page parent links are malformed.'); pageBoxWalk(structure, childRef, reference, pages, seen); }
    return;
  }
  if (type !== 'Page' || (parent && (!entries.get('Parent') || !sameRef(entries.get('Parent'), parent)))) unsupported('The page tree contains an unsupported node.');
  pages.push(Object.freeze({ reference: Object.freeze({ ...reference }), entries }));
}
function inheritedFieldEntry(structure, widgetRef, key) {
  const seen = new Set(); let current = widgetRef;
  for (let depth = 0; depth < 16; depth += 1) {
    const id = `${current.object}:${current.generation}`; if (seen.has(id)) unsupported('The field parent graph contains a cycle.'); seen.add(id);
    const entries = resolvedDictionary(structure, current, 'field widget'); if (entries.has(key)) return entries.get(key);
    const parent = entries.get('Parent'); if (parent?.type !== 'ref') return undefined; current = ref(parent);
  }
  unsupported('The field parent graph is too deep.');
}
function admit(source, request) {
  if (!Buffer.isBuffer(source) || source.length < 32 || source.length > MAX_SOURCE_BYTES || source.includes(Buffer.from('/Encrypt', 'latin1'))) unsupported('Only bounded unencrypted PDF sources are admitted.');
  if (digest(source) !== request.sourceSha256) invalid('sourceSha256 does not match source bytes.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported('Only valid classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1) unsupported('Only one unsigned source revision is admitted.');
  const catalog = resolvedDictionary(structure, structure.root, 'catalog'); if (catalog.get('Type')?.value !== 'Catalog' || catalog.get('Pages')?.type !== 'ref') unsupported('The catalog is outside the passive form subset.');
  const pages = []; pageBoxWalk(structure, ref(catalog.get('Pages')), null, pages, new Set()); if (pages.length < 1 || pages.length > 10_000) unsupported('The page count is outside the bound.');
  const seenObjects = new Set(); for (const entry of structure.effective.values()) if (entry.status === 'n') { const object = resolveClassicPdfObject(structure, ref({ type: 'ref', object: entry.object, generation: entry.generation })); rejectActiveValue(object.value, `object ${entry.object}`, structure, seenObjects); }
  const acroRef = catalog.get('AcroForm'); if (acroRef?.type !== 'ref') unsupported('An existing AcroForm is required.'); const acro = resolvedDictionary(structure, ref(acroRef), 'AcroForm'); if (acro.get('Fields')?.type !== 'array') unsupported('The AcroForm field tree is malformed.');
  const selected = pages[request.target.page - 1]; if (!selected) invalid('target.page is outside the document.'); const annots = selected.entries.get('Annots'); if (annots?.type !== 'array' || request.target.annotationIndex >= annots.values.length) invalid('target does not identify an existing page widget.');
  const annotationRefs = annots.values.map((value) => ref(value)); const unique = new Set(annotationRefs.map((value) => `${value.object}:${value.generation}`)); if (unique.size !== annotationRefs.length) unsupported('The page annotation inventory contains duplicate widget references.');
  const widgetRef = annotationRefs[request.target.annotationIndex]; const widget = resolvedDictionary(structure, widgetRef, 'target widget'); if (widget.get('Type')?.value !== 'Annot' || widget.get('Subtype')?.value !== 'Widget') invalid('target does not identify a widget.');
  const type = fieldType(inheritedFieldEntry(structure, widgetRef, 'FT')); if (!['text', 'button', 'choice'].includes(type)) unsupported('Only non-signature AcroForm widgets are admitted.');
  if (fingerprint(request.sourceSha256, request.target.page, request.target.annotationIndex, type) !== request.target.fingerprint) invalid('target fingerprint does not match the trusted source inventory.');
  const fieldRefs = acro.get('Fields').values.map((value) => ref(value)); const fieldSet = new Set(); const fieldWidgets = new Set();
  function walkField(reference, stack = new Set()) {
    const id = `${reference.object}:${reference.generation}`; if (fieldSet.has(id)) unsupported('The AcroForm field inventory contains duplicate references.'); if (stack.has(id)) unsupported('The AcroForm field inventory contains a cycle.'); fieldSet.add(id);
    const entries = resolvedDictionary(structure, reference, 'AcroForm field'); if (entries.get('Subtype')?.value === 'Widget') fieldWidgets.add(id);
    const kids = entries.get('Kids'); if (kids === undefined) return; if (kids.type !== 'array' || kids.values.length < 1) unsupported('The AcroForm field Kids array is malformed.'); for (const child of kids.values) walkField(ref(child), new Set([...stack, id]));
  }
  for (const value of fieldRefs) walkField(value); if (!fieldWidgets.has(`${widgetRef.object}:${widgetRef.generation}`)) unsupported('The target widget is not reachable from the AcroForm field tree.');
  const pageTabs = selected.entries.get('Tabs'); if (pageTabs && (pageTabs.type !== 'name' || !['S', 'R', 'C'].includes(pageTabs.value))) unsupported('The selected page has an unsupported tab-order mode.');
  return Object.freeze({ structure, catalog, pages, page: selected, widgetRef: Object.freeze({ ...widgetRef }), widget, fieldType: type });
}
function build(source, normalized, admission) {
  const widgetEntries = new Map(admission.widget); widgetEntries.set('TU', pdfUtf16BeString(normalized.tooltip));
  const pageEntries = new Map(admission.page.entries); pageEntries.set('Tabs', name('S'));
  const transaction = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: admission.structure, updates: [{ reference: admission.widgetRef, value: dict(widgetEntries) }, { reference: admission.page.reference, value: dict(pageEntries) }], additions: [], info: { kind: 'preserve' }, changingId: null });
  const bytes = Buffer.concat([source, transaction.revision.bytes]);
  return Object.freeze({ bytes, proof: Object.freeze({ profile: PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE, sourceSha256: normalized.sourceSha256, page: normalized.target.page, annotationIndex: normalized.target.annotationIndex, fingerprint: normalized.target.fingerprint, fieldType: admission.fieldType, tooltipSha256: digest(Buffer.from(normalized.tooltip, 'utf8')), tabOrder: 'S', widget: plainReference(admission.widgetRef), pageReference: plainReference(admission.page.reference), sourcePrefixPreserved: true, revisionCount: 2, changedObjectCount: 2, widgetValueAppearanceGeometryPreserved: true, pageResourcesAnnotationsPreserved: true }) });
}
function compareValues(left, right) { return serializePdfValue(left) === serializePdfValue(right); }

export function preparePdfAcroFormTabOrderTooltip(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes)) invalid('sourceBytes must be a Buffer.'); const source = Buffer.from(sourceBytes); const normalized = normalizePdfAcroFormTabOrderTooltip(request); const admission = admit(source, normalized); const built = build(source, normalized, admission); return built;
}

export function inspectPdfAcroFormTabOrderTooltip(sourceBytes, outputBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || !Buffer.isBuffer(outputBytes) || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) outputInvalid('The output does not preserve the source prefix.');
  const normalized = normalizePdfAcroFormTabOrderTooltip(request); const sourceAdmission = admit(sourceBytes, normalized); const expected = build(sourceBytes, normalized, sourceAdmission);
  if (!outputBytes.equals(expected.bytes)) outputInvalid('The output bytes do not match the planned transaction.');
  let outputStructure; try { outputStructure = parseClassicPdfStructure(outputBytes); } catch { outputInvalid('The output is not a valid classic PDF.'); }
  if (outputStructure.revisions.length !== 2) outputInvalid('The output must contain exactly one appended revision.');
  const sourceStructure = sourceAdmission.structure;
  const widgetObject = resolveClassicPdfObject(outputStructure, sourceAdmission.widgetRef); const pageObject = resolveClassicPdfObject(outputStructure, sourceAdmission.page.reference);
  const widgetEntries = pdfDictionary(widgetObject.value); const pageEntries = pdfDictionary(pageObject.value);
  for (const [key, value] of sourceAdmission.widget) if (key !== 'TU' && (!widgetEntries.has(key) || !compareValues(widgetEntries.get(key), value))) outputInvalid('The widget value, appearance, or geometry changed.');
  if (widgetEntries.get('TU')?.type !== 'string' || !widgetEntries.get('TU').bytes.equals(pdfUtf16BeString(normalized.tooltip).bytes)) outputInvalid('The tooltip is missing or changed.');
  for (const [key, value] of sourceAdmission.page.entries) if (key !== 'Tabs' && (!pageEntries.has(key) || !compareValues(pageEntries.get(key), value))) outputInvalid('Page resources or annotations changed.');
  if (pageEntries.get('Tabs')?.type !== 'name' || pageEntries.get('Tabs').value !== 'S') outputInvalid('The selected page tab order is not structural.');
  for (const entry of sourceStructure.effective.values()) if (entry.status === 'n' && entry.object !== sourceAdmission.widgetRef.object && entry.object !== sourceAdmission.page.reference.object) {
    const reference = ref({ type: 'ref', object: entry.object, generation: entry.generation }); const before = resolveClassicPdfObject(sourceStructure, reference); const after = resolveClassicPdfObject(outputStructure, reference); if (!compareValues(before.value, after.value) || before.stream !== after.stream) outputInvalid('An unrelated object changed.');
  }
  return expected.proof;
}

export const buildPdfAcroFormTabOrderTooltip = preparePdfAcroFormTabOrderTooltip;
export const verifyPdfAcroFormTabOrderTooltip = inspectPdfAcroFormTabOrderTooltip;
export const preparePdfAcroFormTabOrderTooltips = preparePdfAcroFormTabOrderTooltip;
export const inspectPdfAcroFormTabOrderTooltips = inspectPdfAcroFormTabOrderTooltip;
