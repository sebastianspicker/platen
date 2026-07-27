import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { normalizePdfFormJavaScriptInventoryRequest, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS, PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE } from './pdf-form-javascript-contract.mjs';

const TRIGGERS = Object.freeze(new Map([['K', 'keystroke'], ['F', 'format'], ['V', 'validate'], ['C', 'calculate']]));
function failure(message = 'The source is outside the bounded form JavaScript inventory subset.') { const error = new Error(message); error.code = 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE'; throw error; }
function outputFailure() { const error = new Error('The form JavaScript inventory result failed independent verification.'); error.code = 'INVALID_PDF_FORM_JAVASCRIPT_INVENTORY_OUTPUT'; throw error; }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function key(reference) { return `${reference.object}:${reference.generation}`; }
function sameRef(left, right) { return left?.type === 'ref' && right?.type === 'ref' && left.object === right.object && left.generation === right.generation; }
function ref(value, label) { if (value?.type !== 'ref') failure(`${label} must be an indirect reference.`); return Object.freeze({ type: 'ref', object: value.object, generation: value.generation }); }
function publicRef(value) { return Object.freeze({ object: value.object, generation: value.generation }); }
function numericRect(value) { if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry?.type !== 'number' || !Number.isFinite(entry.value))) failure('Widget Rect must be a direct four-number array.'); }
function partialFieldName(value) { if (value?.type !== 'string' || value.bytes.length < 1 || value.bytes.length > 127 || [...value.bytes].some((byte) => byte < 0x20 || byte > 0x7e || byte === 0x2e)) failure('Field T must be a bounded printable ASCII root partial name without periods.'); return value.bytes.toString('ascii'); }
function checkedRequest(source, value) { let request; try { request = normalizePdfFormJavaScriptInventoryRequest(value); } catch { failure('The inventory request is invalid.'); } if (sha(source) !== request.sourceSha256) failure('sourceSha256 does not match source bytes.'); return request; }
function countNodes(value, state) { if (!value || typeof value !== 'object') return; state.count += 1; if (state.count > PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxNodes) failure('The parsed PDF value graph exceeds its node bound.'); if (value.type === 'dict') for (const child of value.entries.values()) countNodes(child, state); else if (value.type === 'array') for (const child of value.values) countNodes(child, state); }

function parseSource(source) {
  if (!Buffer.isBuffer(source) || (typeof SharedArrayBuffer !== 'undefined' && source.buffer instanceof SharedArrayBuffer)
    || source.length < 32 || source.length > PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxSourceBytes) failure('Source bytes are outside the fixed bound.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { failure('Only valid classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1 || structure.revisions[0].xrefKind === 'stream' || structure.info || structure.id
    || structure.revisions.some((revision) => revision.trailer.has('Encrypt'))) failure('Only one unsigned, unencrypted classic revision without Info or IDs is admitted.');
  const effective = [...structure.effective.values()].filter((entry) => entry.status === 'n' && entry.object !== 0);
  if (effective.length > PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxObjects || [...structure.effective.values()].some((entry) => entry.status === 'c')) failure('The PDF object table is outside the fixed bound.');
  const nodes = { count: 0 };
  for (const entry of effective) { const object = resolveClassicPdfObject(structure, { type: 'ref', object: entry.object, generation: entry.generation }); countNodes(object.value, nodes); const value = object.value?.type === 'dict' ? pdfDictionary(object.value) : null; if (value?.has('ByteRange') || value?.get('FT')?.value === 'Sig' || value?.get('Type')?.value === 'Sig' || value?.has('XFA') || value?.has('Perms')) failure('Signatures, permissions, and XFA are not admitted.'); }
  return Object.freeze({ structure, effective, nodeCount: nodes.count });
}

function analyze(source, request, parsed) {
  const { structure, effective, nodeCount } = parsed; const visited = new Set(); const pages = []; const annotationOwners = new Map();
  function resolve(reference, label, stream = false) { const referenceKey = key(reference); if (visited.has(referenceKey)) failure(`${label} is aliased or referenced more than once.`); visited.add(referenceKey); const object = resolveClassicPdfObject(structure, reference); if (Boolean(object.stream) !== stream) failure(`${label} has an unsupported stream shape.`); return object; }
  const root = ref(structure.root, 'Root'); const catalogObject = resolve(root, 'Catalog'); const catalog = pdfDictionary(catalogObject.value); const catalogKeys = catalog.has('AcroForm') ? ['Type', 'Pages', 'AcroForm'] : ['Type', 'Pages'];
  if (catalog.size !== catalogKeys.length || [...catalog.keys()].some((entry) => !catalogKeys.includes(entry)) || catalog.get('Type')?.value !== 'Catalog') failure('Catalog must contain only Pages and an optional AcroForm.');
  const pagesReference = ref(catalog.get('Pages'), 'Catalog Pages'); const pagesObject = resolve(pagesReference, 'Pages'); const pagesDictionary = pdfDictionary(pagesObject.value);
  if (pagesDictionary.size !== 3 || pagesDictionary.get('Type')?.value !== 'Pages' || pagesDictionary.get('Kids')?.type !== 'array' || pagesDictionary.get('Count')?.type !== 'number' || !pagesDictionary.get('Count').integer || pagesDictionary.get('Count').value !== pagesDictionary.get('Kids').values.length || pagesDictionary.get('Count').value < 1) failure('Only one flat bounded Pages node is admitted.');
  for (const pageValue of pagesDictionary.get('Kids').values) {
    const pageReference = ref(pageValue, 'Page'); const pageObject = resolve(pageReference, 'Page'); const page = pdfDictionary(pageObject.value); const allowed = new Set(['Type', 'Parent', 'MediaBox', 'CropBox', 'Resources', 'Contents', 'Annots']);
    if (page.get('Type')?.value !== 'Page' || !sameRef(page.get('Parent'), pagesReference) || [...page.keys()].some((entry) => !allowed.has(entry)) || page.get('Resources')?.type !== 'dict' || page.get('Resources').entries.size !== 0 || page.get('MediaBox')?.type !== 'array') failure('Pages must use direct empty resources and explicit bounded entries.');
    numericRect(page.get('MediaBox')); if (page.has('CropBox')) numericRect(page.get('CropBox'));
    const contents = page.get('Contents'); if (contents?.type === 'ref') { const contentReference = ref(contents, 'Page Contents'); const content = resolve(contentReference, 'Page Contents', true); const dictionary = pdfDictionary(content.value); if (dictionary.size !== 1 || dictionary.get('Length')?.type !== 'number' || dictionary.get('Length').value !== content.streamLength) failure('Content streams must contain only an exact Length.'); } else if (contents !== undefined) failure('Page Contents must be one stream reference.');
    const annotations = page.get('Annots');
    if (annotations !== undefined) { if (annotations.type !== 'array' || annotations.values.length > PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxFields) failure('Page Annots is outside the fixed field bound.'); for (const value of annotations.values) { const annotation = ref(value, 'Widget annotation'); const owners = annotationOwners.get(key(annotation)) ?? []; owners.push(pageReference); annotationOwners.set(key(annotation), owners); } }
    pages.push(pageReference);
  }
  if (pages.length !== pagesDictionary.get('Count').value) failure('Page count is inconsistent.');
  const loci = []; const fieldsSeen = new Set(); const fieldNames = new Set(); const actionReferences = new Set(); let totalScriptBytes = 0;
  if (catalog.has('AcroForm')) {
    const acroReference = ref(catalog.get('AcroForm'), 'AcroForm'); const acroObject = resolve(acroReference, 'AcroForm'); const acro = pdfDictionary(acroObject.value);
    if (acro.size !== 1 || acro.get('Fields')?.type !== 'array' || acro.get('Fields').values.length > PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxFields) failure('AcroForm must contain only a bounded Fields array.');
    for (const fieldValue of acro.get('Fields').values) {
      const fieldReference = ref(fieldValue, 'Field'); const fieldKey = key(fieldReference); if (fieldsSeen.has(fieldKey)) failure('Duplicate fields are not admitted.'); fieldsSeen.add(fieldKey); const fieldObject = resolve(fieldReference, 'Field'); const field = pdfDictionary(fieldObject.value); const allowed = new Set(['Type', 'Subtype', 'FT', 'F', 'Ff', 'T', 'Rect', 'P', 'AA']);
      if ([...field.keys()].some((entry) => !allowed.has(entry)) || field.get('Type')?.value !== 'Annot' || field.get('Subtype')?.value !== 'Widget' || field.get('FT')?.value !== 'Tx' || field.get('P')?.type !== 'ref') failure('Only merged terminal text widgets are admitted.');
      const fieldName = partialFieldName(field.get('T')); if (fieldNames.has(fieldName)) failure('Duplicate root partial field names are not admitted.'); fieldNames.add(fieldName);
      numericRect(field.get('Rect')); if (field.has('F') && (field.get('F')?.type !== 'number' || !field.get('F').integer)) failure('Widget F must be an integer.'); if (field.has('Ff') && (field.get('Ff')?.type !== 'number' || !field.get('Ff').integer)) failure('Widget Ff must be an integer.');
      const owners = annotationOwners.get(fieldKey); if (!owners || owners.length !== 1 || !sameRef(owners[0], field.get('P'))) failure('Every field must appear exactly once across all page Annots and on its declared P page.');
      const aa = field.get('AA'); if (aa === undefined) continue; if (aa.type !== 'dict' || aa.entries.size < 1 || [...aa.entries.keys()].some((trigger) => !TRIGGERS.has(trigger))) failure('Only K, F, V, and C field additional-action triggers are admitted.');
      for (const [trigger, actionValue] of aa.entries) {
        if (loci.length >= PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxActions) failure('The action count exceeds its fixed bound.'); const actionReference = ref(actionValue, 'JavaScript action'); const actionKey = key(actionReference); if (actionReferences.has(actionKey)) failure('Shared or chained actions are not admitted.'); actionReferences.add(actionKey); const actionObject = resolve(actionReference, 'JavaScript action'); const action = pdfDictionary(actionObject.value); const script = action.get('JS');
        if (action.size !== 2 || action.get('S')?.value !== 'JavaScript' || script?.type !== 'string' || script.bytes.length < 1 || script.bytes.length > PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxScriptBytes) failure('Actions must be exact inline bounded JavaScript dictionaries.');
        totalScriptBytes += script.bytes.length; if (totalScriptBytes > PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxTotalScriptBytes) failure('The total script byte count exceeds its fixed bound.');
        loci.push(Object.freeze({ locus: 'field-additional-action', trigger: TRIGGERS.get(trigger), fieldReference: publicRef(fieldReference), fieldNameBytesSha256: sha(field.get('T').bytes), actionReference: publicRef(actionReference), scriptSha256: sha(script.bytes), scriptBytes: script.bytes.length }));
      }
    }
  }
  for (const annotationKey of annotationOwners.keys()) if (!fieldsSeen.has(annotationKey)) failure('Page Annots contains a non-field or unlisted widget.');
  if (visited.size !== effective.length) failure('Unreachable or unsupported indirect objects are not admitted.');
  return Object.freeze({ schema: 'pdf-form-javascript-inventory-v1', profile: PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE, sourceSha256: request.sourceSha256, sourceBytes: source.length, revisionCount: 1, visitedObjectCount: visited.size, parsedNodeCount: nodeCount, actionCount: loci.length, totalScriptBytes, actionLoci: Object.freeze(loci), reviewOnly: true, rawScriptTextIncluded: false, activeContentExecuted: false });
}

export function analyzePdfFormJavaScript(sourceBytes, value) { if (!Buffer.isBuffer(sourceBytes) || (typeof SharedArrayBuffer !== 'undefined' && sourceBytes.buffer instanceof SharedArrayBuffer)) failure('Source bytes must be a private Buffer.'); const source = Buffer.from(sourceBytes); const request = checkedRequest(source, value); return analyze(source, request, parseSource(source)); }

function stableCandidate(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) { if (isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) outputFailure(); const descriptors = Object.getOwnPropertyDescriptors(value); if (Reflect.ownKeys(value).some((entry) => entry !== 'length' && (!/^\d+$/u.test(String(entry)) || !Object.hasOwn(descriptors[entry], 'value') || descriptors[entry].enumerable !== true))) outputFailure(); return value.map(stableCandidate); }
  if (!value || typeof value !== 'object' || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((entry) => typeof entry !== 'string')) outputFailure(); const descriptors = Object.getOwnPropertyDescriptors(value); for (const descriptor of Object.values(descriptors)) if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) outputFailure(); return Object.fromEntries(Object.entries(descriptors).map(([entry, descriptor]) => [entry, stableCandidate(descriptor.value)]));
}
export function inspectPdfFormJavaScriptAnalysis(sourceBytes, value, candidate) { const expected = analyzePdfFormJavaScript(sourceBytes, value); let normalized; try { normalized = stableCandidate(candidate); } catch (error) { if (error?.code === 'INVALID_PDF_FORM_JAVASCRIPT_INVENTORY_OUTPUT') throw error; outputFailure(); } if (JSON.stringify(normalized) !== JSON.stringify(expected)) outputFailure(); return expected; }
