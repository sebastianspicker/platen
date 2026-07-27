import { createHash } from 'node:crypto';
import { pdfDictionary, serializePdfValue } from './pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from './pdf-classic-text-string.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { planClassicObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { normalizePdfAccessibilityFormSemantics, PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE } from './pdf-accessibility-form-semantics-contract.mjs';

const ACTIVE = new Set(['A', 'AA', 'OpenAction', 'JavaScript', 'JS', 'Launch', 'URI', 'SubmitForm', 'ResetForm', 'ImportData', 'XFA', 'StructTreeRoot', 'Metadata', 'OCProperties', 'OC', 'OCGs', 'Layer', 'Perms', 'Outlines', 'Names', 'AF', 'EmbeddedFiles', 'RichMediaContent', 'Sound', 'Movie', 'ByteRange', 'Reference', 'TransformMethod']);
const TYPES = new Set(['Sig', 'DocTimeStamp']);
const FT = Object.freeze({ text: 'Tx', button: 'Btn', choice: 'Ch' });
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'The source is outside the passive accessible-form semantics subset.') { throw failure('UNSUPPORTED_PDF_ACCESSIBILITY_FORM_SEMANTICS', message); }
function invalid(message = 'The accessible-form semantics request is invalid.') { throw failure('INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS', message); }
function outputInvalid(message = 'The accessible-form semantics output failed independent verification.') { throw failure('INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function ref(value) { if (value?.type !== 'ref') unsupported('Indirect references are required.'); return { type: 'ref', object: value.object, generation: value.generation }; }
function sameRef(a, b) { return a?.object === b?.object && a?.generation === b?.generation; }
function name(value) { return Object.freeze({ type: 'name', value }); }
function array(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function dict(entries) { return Object.freeze({ type: 'dict', entries: new Map(entries) }); }
function direct(structure, reference, label) { const object = resolveClassicPdfObject(structure, reference); if (object.stream || object.value?.type !== 'dict') unsupported(`${label} must be a direct dictionary.`); return pdfDictionary(object.value); }
function walkHazards(value, seen, structure) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'dict') {
    for (const [key, child] of value.entries) {
      if (ACTIVE.has(key)) unsupported('Active content, tags, layers, or attachments are not admitted.');
      if ((key === 'FT' && child?.type === 'name' && child.value === 'Sig') || (key === 'Type' && child?.type === 'name' && TYPES.has(child.value)) || (key === 'Subtype' && child?.type === 'name' && TYPES.has(child.value))) unsupported('Signatures are not admitted.');
      walkHazards(child, seen, structure);
    }
  } else if (value.type === 'array') for (const child of value.values) walkHazards(child, seen, structure);
  else if (value.type === 'ref') { const key = `${value.object}:${value.generation}`; if (seen.has(key)) return; seen.add(key); const object = resolveClassicPdfObject(structure, value); if (!object.stream) walkHazards(object.value, seen, structure); }
}
function pages(structure, pagesRef) {
  const root = direct(structure, pagesRef, 'pages'); if (root.get('Type')?.value !== 'Pages' || root.get('Kids')?.type !== 'array' || root.get('Count')?.value !== root.get('Kids').values.length || root.get('Kids').values.length < 1 || root.get('Kids').values.length > 10_000) unsupported('Only a flat bounded page tree is admitted.');
  return root.get('Kids').values.map((child) => { const reference = ref(child); const entries = direct(structure, reference, 'page'); if (entries.get('Type')?.value !== 'Page' || !sameRef(entries.get('Parent'), pagesRef) || entries.get('Annots')?.type !== 'array') unsupported('Every page must have a direct annotation inventory.'); return Object.freeze({ reference, entries }); });
}
function fieldRole(value) { const type = value?.type === 'name' ? value.value : null; return type === 'Tx' ? 'text' : type === 'Btn' ? 'button' : type === 'Ch' ? 'choice' : null; }
function fingerprint(sourceSha256, page, annotationIndex, role) { return digest(Buffer.from(['pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`, `page=${page}`, `annotation-index=${annotationIndex}`, 'subtype=widget', `widget-type=${role}`].join('\n'), 'utf8')); }
function admit(source, request) {
  if (!Buffer.isBuffer(source) || source.length < 32 || source.length > 32 * 1024 * 1024 || source.includes(Buffer.from('/Encrypt', 'latin1'))) unsupported('Only bounded unencrypted sources are admitted.');
  if (digest(source) !== request.sourceSha256) invalid('sourceSha256 does not match source bytes.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported('Only valid classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1) unsupported('Only one unsigned source revision is admitted.');
  const catalog = direct(structure, structure.root, 'catalog'); if (catalog.get('Type')?.value !== 'Catalog' || catalog.get('Pages')?.type !== 'ref' || catalog.get('AcroForm')?.type !== 'ref') unsupported('A classic AcroForm catalog is required.');
  const pageList = pages(structure, ref(catalog.get('Pages'))); const acro = direct(structure, ref(catalog.get('AcroForm')), 'AcroForm'); if (acro.get('Fields')?.type !== 'array' || acro.get('Fields').values.length < 1) unsupported('The AcroForm field tree is malformed.');
  const fieldRefs = new Set(); const widgetRefs = new Set();
  function walkField(reference, stack = new Set()) {
    const key = `${reference.object}:${reference.generation}`; if (stack.has(key) || fieldRefs.has(key)) unsupported('The AcroForm field graph is cyclic, shared, or duplicated.'); fieldRefs.add(key);
    const entries = direct(structure, reference, 'AcroForm field'); const subtype = entries.get('Subtype')?.value;
    if (subtype === 'Widget') widgetRefs.add(key);
    const kids = entries.get('Kids'); if (kids === undefined) return; if (kids.type !== 'array' || kids.values.length < 1) unsupported('The AcroForm field Kids array is malformed.');
    for (const child of kids.values) walkField(ref(child), new Set([...stack, key]));
  }
  for (const child of acro.get('Fields').values) walkField(ref(child));
  walkHazards(catalog, new Set(), structure); for (const entry of structure.effective.values()) if (entry.status === 'n') { const object = resolveClassicPdfObject(structure, ref({ type: 'ref', object: entry.object, generation: entry.generation })); walkHazards(object.value, new Set(), structure); }
  const selectedPages = new Map(pageList.map((page, index) => [index + 1, page])); const targets = [];
  for (const item of request.fields) {
    const page = selectedPages.get(item.target.page); if (!page) invalid('field page is outside the document.'); const annots = page.entries.get('Annots'); if (item.target.annotationIndex >= annots.values.length) invalid('field locator is outside the page annotation inventory.');
    const widgetRef = ref(annots.values[item.target.annotationIndex]); const widget = direct(structure, widgetRef, 'widget'); if (widget.get('Type')?.value !== 'Annot' || widget.get('Subtype')?.value !== 'Widget') invalid('field locator does not identify a widget.');
    if (!widgetRefs.has(`${widgetRef.object}:${widgetRef.generation}`)) invalid('field locator is not a member of the AcroForm field inventory.');
    const role = fieldRole(widget.get('FT')); if (!role || role !== item.role || fingerprint(request.sourceSha256, item.target.page, item.target.annotationIndex, role) !== item.target.fingerprint) invalid('field role or locator does not match the trusted source inventory.');
    if (widget.get('T')?.type !== 'string' || widget.get('FT')?.type !== 'name') unsupported('Only direct terminal fields with a current field name are admitted.');
    targets.push(Object.freeze({ item, page, widgetRef, widget }));
  }
  const pageSet = new Set(targets.map((target) => target.item.target.page)); if (pageSet.size !== 1) unsupported('All fields must be on one page in this bounded subset.');
  return Object.freeze({ structure, pageList, targets, page: targets[0].page });
}
function build(source, request, state) {
  const updates = []; const byPage = new Map();
  for (const target of state.targets) {
    const entries = new Map(target.widget);
    entries.set('T', pdfUtf16BeString(target.item.name));
    if (target.item.tooltip) entries.set('TU', pdfUtf16BeString(target.item.tooltip));
    else entries.delete('TU');
    updates.push({ reference: target.widgetRef, value: dict(entries) });
    byPage.set(target.item.target.page, target.page);
  }
  for (const [pageNumber, page] of byPage) {
    const ordered = [...state.targets]
      .sort((a, b) => a.item.tabIndex - b.item.tabIndex)
      .map((target) => target.widgetRef);
    const existing = page.entries.get('Annots').values;
    const selected = new Set(ordered.map((entry) => `${entry.object}:${entry.generation}`));
    const annots = [...ordered, ...existing.filter((entry) => !selected.has(`${entry.object}:${entry.generation}`))];
    const pageEntries = new Map(page.entries);
    pageEntries.set('Annots', array(annots));
    pageEntries.set('Tabs', name('S'));
    updates.push({ reference: page.reference, value: dict(pageEntries) });
  }
  const transaction = planClassicObjectTransaction({ sourceBytes: source, sourceStructure: state.structure, updates, additions: [], info: { kind: 'preserve' }, changingId: null }); const bytes = Buffer.concat([source, transaction.revision.bytes]);
  return Object.freeze({ bytes, proof: Object.freeze({ profile: PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE, sourceSha256: request.sourceSha256, fieldCount: state.targets.length, page: state.targets[0].item.target.page, tabOrder: 'S', orderedWidgetObjects: Object.freeze([...state.targets].sort((a, b) => a.item.tabIndex - b.item.tabIndex).map((target) => Object.freeze({ object: target.widgetRef.object, generation: target.widgetRef.generation }))), sourcePrefixPreserved: true, revisionCount: 2, changedObjectCount: updates.length, rolePreserved: true, namesAndTooltipsBound: true }) });
}
export function writePdfAccessibilityFormSemantics(sourceBytes, requestValue) { const request = normalizePdfAccessibilityFormSemantics(requestValue); const state = admit(sourceBytes, request); return build(sourceBytes, request, state); }
export function inspectPdfAccessibilityFormSemantics(sourceBytes, outputBytes, requestValue) {
  const request = normalizePdfAccessibilityFormSemantics(requestValue);
  const state = admit(sourceBytes, request); const expected = build(sourceBytes, request, state);
  if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(expected.bytes)) outputInvalid();
  if (!outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) outputInvalid('The source prefix changed.');
  let parsed;
  try { parsed = parseClassicPdfStructure(outputBytes); } catch { outputInvalid('The output is not a valid classic PDF.'); }
  if (parsed.revisions.length !== 2) outputInvalid('Exactly one append-only revision is required.');
  for (const entry of state.structure.effective.values()) {
    const target = state.targets.some((item) => item.widgetRef.object === entry.object);
    if (entry.status !== 'n' || target || entry.object === state.page.reference.object) continue;
    const reference = ref({ type: 'ref', object: entry.object, generation: entry.generation });
    const before = resolveClassicPdfObject(state.structure, reference);
    const after = resolveClassicPdfObject(parsed, reference);
    if (serializePdfValue(before.value) !== serializePdfValue(after.value)) outputInvalid('An unrelated object changed.');
  }
  return expected.proof;
}
export const preparePdfAccessibilityFormSemantics = writePdfAccessibilityFormSemantics;
export const verifyPdfAccessibilityFormSemantics = inspectPdfAccessibilityFormSemantics;
