import { createHash } from 'node:crypto';
import {
  findFinalStartXref, parseClassicXrefSection, pdfDictionary, pdfInteger, pdfReference,
  pdfStringBytes, serializePdfValue,
} from './pdf-classic-syntax.mjs';
import { CLASSIC_PDF_STRUCTURE_LIMITS, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import {
  PDF_LAYER_DEFAULTS_PROFILE, normalizePdfLayerDefaults,
} from './pdf-layer-defaults-contract.mjs';

const MAX_GROUPS = 100;
const MAX_PAGES = 100;
const GEOMETRY_KEYS = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate', 'UserUnit'];
const ACTIVE_KEYS = new Set([
  'A', 'AA', 'OpenAction', 'JS', 'Launch', 'SubmitForm', 'ResetForm', 'ImportData',
  'RichMediaContent', 'Sound', 'Movie', '3D', '3DD', 'Rendition', 'Trans',
]);
const HAZARD_KEYS = new Set([
  'AcroForm', 'AF', 'EF', 'EmbeddedFiles', 'Filespec', 'ByteRange', 'StructTreeRoot',
  'StructParents', 'ParentTree', 'RoleMap', 'ClassMap', 'MarkInfo', 'Perms', 'Encrypt',
]);
const HAZARD_TYPES = new Set(['Sig', 'OCMD', 'EmbeddedFile', 'Filespec', 'StructElem', 'Annot']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'PDF is outside the supported bounded layer-defaults subset.') {
  return failure('UNSUPPORTED_PDF_LAYER_DEFAULTS_PDF', message);
}
function invalidOutput() { return failure('INVALID_PDF_LAYER_DEFAULTS_OUTPUT', 'PDF layer-defaults output proof failed.'); }
function sameReference(a, b) { return a.object === b.object && a.generation === b.generation; }
function referenceText(ref) { return `${ref.object} ${ref.generation} R`; }
function pdfName(value) { return Object.freeze({ type: 'name', value }); }
function pdfArray(values) { return Object.freeze({ type: 'array', values: Object.freeze(values) }); }
function sourceSha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function rejectTrailerEncryption(bytes) {
  try {
    let offset = findFinalStartXref(bytes); const seen = new Set();
    for (let revision = 0; revision < CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions; revision += 1) {
      if (seen.has(offset)) return; seen.add(offset);
      if (!/^xref(?:\x00|\x09|\x0a|\x0c|\x0d|\x20)/u.test(bytes.subarray(offset, offset + 6).toString('latin1'))) return;
      const section = parseClassicXrefSection(bytes, offset);
      if (section.trailer.has('Encrypt')) throw unsupported('Encrypted PDFs are not supported.');
      if (!section.trailer.has('Prev')) return;
      offset = pdfInteger(section.trailer.get('Prev'));
    }
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_PDF_LAYER_DEFAULTS_PDF') throw error;
  }
}

function parseSource(bytes) {
  if (!Buffer.isBuffer(bytes) || (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)) throw unsupported();
  rejectTrailerEncryption(bytes);
  try {
    const structure = parsePdfStructure(bytes);
    if (structure.encrypt || structure.encryption
      || structure.revisions.some((revision) => revision.trailer?.has?.('Encrypt'))) throw unsupported('Encrypted PDFs are not supported.');
    return structure;
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_PDF_LAYER_DEFAULTS_PDF') throw error;
    throw unsupported();
  }
}

function resolveDictionary(structure, value, direct = false) {
  if (direct && value?.type !== 'dict') throw unsupported();
  const resolved = value?.type === 'ref' ? resolvePdfObject(structure, pdfReference(value)) : { value, stream: false };
  if (resolved.stream || resolved.value?.type !== 'dict') throw unsupported();
  return pdfDictionary(resolved.value);
}

function rejectHazards(structure, allowedRoot) {
  const check = (object) => {
    if (structure.controlObjectNumbers?.has(object.reference.object)) return;
    if (object.stream && object.value?.type === 'dict'
      && object.value.entries.get('Type')?.type === 'name'
      && ['XRef', 'ObjStm'].includes(object.value.entries.get('Type').value)) return;
    if (object.value?.type !== 'dict') return;
    const entries = object.value.entries;
    const type = entries.get('Type');
    if (object.reference.object !== allowedRoot.object && entries.has('OCProperties')) throw unsupported('Only the catalog may contain OCProperties.');
    if ([...HAZARD_KEYS].some((key) => entries.has(key)) || [...ACTIVE_KEYS].some((key) => entries.has(key))) throw unsupported('Active content, forms, tags, attachments, or signatures are not supported.');
    if (type?.type === 'name' && HAZARD_TYPES.has(type.value)) throw unsupported('Active or unsupported PDF object type.');
    const action = entries.get('S');
    if (action?.type === 'name' && ['JavaScript', 'Launch', 'SubmitForm', 'ResetForm', 'ImportData', 'Rendition', 'Sound', 'Movie', 'GoToE', 'GoToR', 'URI', 'SetOCGState'].includes(action.value)) throw unsupported();
    if (entries.has('FT')) throw unsupported('Forms are not supported.');
  };
  visitPdfObjects(structure, check);
}

function inspectOptionalContent(structure) {
  const catalog = resolvePdfObject(structure, structure.root);
  if (catalog.stream) throw unsupported();
  const catalogEntries = pdfDictionary(catalog.value);
  if (catalogEntries.get('Type')?.type !== 'name' || catalogEntries.get('Type').value !== 'Catalog') throw unsupported();
  const ocProperties = resolveDictionary(structure, catalogEntries.get('OCProperties'), true);
  if (ocProperties.has('Configs') || ocProperties.has('AS') || !ocProperties.has('OCGs') || !ocProperties.has('D')) throw unsupported();
  const ocgs = ocProperties.get('OCGs');
  if (ocgs?.type !== 'array' || ocgs.values.length < 1 || ocgs.values.length > MAX_GROUPS) throw unsupported();
  const references = ocgs.values.map((entry) => pdfReference(entry));
  const keys = references.map(referenceText);
  if (new Set(keys).size !== keys.length) throw unsupported('OCG references must be unique.');
  const groups = references.map((reference) => {
    const object = resolvePdfObject(structure, reference);
    if (object.stream || object.value?.type !== 'dict') throw unsupported();
    const entries = pdfDictionary(object.value);
    if (entries.get('Type')?.type !== 'name' || entries.get('Type').value !== 'OCG'
      || !entries.has('Name') || [...entries.keys()].some((key) => !['Type', 'Name', 'Intent'].includes(key))) throw unsupported('OCG dictionaries are not strict passive groups.');
    const nameBytes = pdfStringBytes(entries.get('Name'));
    if (nameBytes.length < 1 || nameBytes.length > 256) throw unsupported('OCG name is outside the bounded decoded limit.');
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { throw unsupported('OCG name is not valid UTF-8.'); }
    if (name.length > 256 || /[\u0000-\u001F\u007F]/u.test(name)) throw unsupported('OCG name contains forbidden control text.');
    if (entries.has('Intent') && (entries.get('Intent').type !== 'name' || entries.get('Intent').value !== 'View')) throw unsupported();
    return Object.freeze({ reference, name });
  });
  const defaults = resolveDictionary(structure, ocProperties.get('D'), true);
  if (defaults.get('BaseState')?.type !== 'name' || defaults.get('BaseState').value !== 'ON' || defaults.has('Configs') || defaults.has('AS')) throw unsupported();
  const known = new Set(keys);
  const readState = (key) => {
    const value = defaults.get(key);
    if (value === undefined) return [];
    if (value.type !== 'array') throw unsupported();
    const seen = new Set();
    for (const entry of value.values) {
      const ref = pdfReference(entry); const text = referenceText(ref);
      if (!known.has(text) || seen.has(text)) throw unsupported(`${key} contains an unknown or duplicate OCG reference.`);
      seen.add(text);
    }
    return [...seen];
  };
  const on = readState('ON'); const off = readState('OFF');
  if (new Set([...on, ...off]).size !== on.length + off.length) throw unsupported('ON and OFF must not overlap.');
  const visible = groups.map((group) => !off.includes(referenceText(group.reference)));
  return Object.freeze({ catalog, catalogEntries, ocProperties, defaults, groups, visible, on, off });
}

function pageSnapshot(structure, state, sourceBytes) {
  let pagesValue;
  try { pagesValue = pdfReference(state.catalogEntries.get('Pages')); } catch { throw unsupported(); }
  const pages = []; const seen = new Set();
  function visit(reference, parent, depth) {
    if (depth > 16 || seen.has(referenceText(reference)) || pages.length > MAX_PAGES) throw unsupported();
    seen.add(referenceText(reference));
    const object = resolvePdfObject(structure, reference); if (object.stream) throw unsupported();
    const entries = pdfDictionary(object.value); const type = entries.get('Type');
    if (type?.type !== 'name' || !['Pages', 'Page'].includes(type.value)) throw unsupported();
    if (parent === null ? entries.has('Parent') : !sameReference(pdfReference(entries.get('Parent')), parent)) throw unsupported();
    if (type.value === 'Page') {
      const geometry = GEOMETRY_KEYS.map((key) => [key, entries.has(key) ? serializePdfValue(entries.get(key)) : null]);
      const contents = entries.get('Contents'); const refs = contents?.type === 'array' ? contents.values.map((value) => pdfReference(value)) : contents ? [pdfReference(contents)] : [];
      const streams = refs.map((contentRef) => {
        const content = resolvePdfObject(structure, contentRef);
        if (!content.stream || !Number.isSafeInteger(content.streamStart) || !Number.isSafeInteger(content.streamLength)) throw unsupported();
        return sourceBytes.subarray(content.streamStart, content.streamStart + content.streamLength);
      });
      pages.push(Object.freeze({ reference, geometry: JSON.stringify(geometry), refs: refs.map(referenceText), streams }));
      return 1;
    }
    const kids = entries.get('Kids'); if (kids?.type !== 'array' || kids.values.length < 1) throw unsupported();
    let count = 0; for (const kid of kids.values) count += visit(pdfReference(kid), reference, depth + 1);
    if (entries.get('Count')?.type !== 'number' || entries.get('Count').value !== count) throw unsupported();
    return count;
  }
  visit(pagesValue, null, 0);
  return Object.freeze(pages);
}

function changedId(source, request) {
  return createHash('sha256').update('Platen layer defaults v1\0', 'utf8')
    .update(createHash('sha256').update(source).digest()).update(JSON.stringify(request), 'utf8').digest().subarray(0, 16);
}

function stateValue(state, request) {
  const visible = [...state.visible];
  for (const change of request.changes) {
    if (change.groupIndex >= visible.length) throw failure('INVALID_PDF_LAYER_DEFAULTS', 'Layer group index is outside the source inventory.');
    visible[change.groupIndex] = change.visible;
  }
  return visible;
}

function canonicalAppend(sourceBytes, structure, state, request) {
  const visible = stateValue(state, request);
  const on = state.groups.filter((_, index) => visible[index]).map((group) => group.reference);
  const off = state.groups.filter((_, index) => !visible[index]).map((group) => group.reference);
  const defaults = new Map(state.defaults); defaults.set('ON', pdfArray(on)); defaults.set('OFF', pdfArray(off));
  const ocProperties = new Map(state.ocProperties); ocProperties.set('D', Object.freeze({ type: 'dict', entries: defaults }));
  const catalog = new Map(state.catalogEntries); catalog.set('OCProperties', Object.freeze({ type: 'dict', entries: ocProperties }));
  try {
    const revision = planPdfObjectTransaction({
      sourceBytes, sourceStructure: structure,
      updates: [{ reference: structure.root, value: Object.freeze({ type: 'dict', entries: catalog }) }],
      additions: [], info: { kind: 'preserve' }, changingId: structure.id ? changedId(sourceBytes, request) : null,
    }).revision;
    return Object.freeze({ revision, bytes: revision.bytes, objectOffset: revision.records[0].offset, xrefOffset: revision.xrefOffset, visible });
  } catch { throw unsupported(); }
}

function verify(sourceBytes, outputBytes, request, source, before, beforePages, append) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)
      || !outputBytes.subarray(sourceBytes.length).equals(append.bytes)) throw invalidOutput();
    const output = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: source, expectedRevision: append.revision }).outputStructure;
    const after = inspectOptionalContent(output); const afterPages = pageSnapshot(output, after, outputBytes);
    if (output.revisions.length !== source.revisions.length + 1 || output.revisions[0].entries.length !== 1
      || output.revisions[0].entries[0].object !== source.root.object || output.revisions[0].entries[0].generation !== source.root.generation
      || output.root.object !== source.root.object || output.root.generation !== source.root.generation) throw invalidOutput();
    for (const [number, entry] of source.effective) {
      const next = output.effective.get(number);
      if (!next || number !== source.root.object && (next.status !== entry.status || next.generation !== entry.generation || next.offset !== entry.offset || next.objectStream !== entry.objectStream || next.index !== entry.index)) throw invalidOutput();
    }
    if (output.effective.size !== source.effective.size || after.groups.length !== before.groups.length
      || after.groups.some((group, index) => !sameReference(group.reference, before.groups[index].reference) || group.name !== before.groups[index].name)
      || after.visible.some((visible, index) => visible !== append.visible[index])
      || afterPages.length !== beforePages.length
      || afterPages.some((page, index) => page.geometry !== beforePages[index].geometry || JSON.stringify(page.refs) !== JSON.stringify(beforePages[index].refs)
        || page.streams.some((bytes, streamIndex) => !bytes.equals(beforePages[index].streams[streamIndex])))) throw invalidOutput();
    return Object.freeze({ profile: PDF_LAYER_DEFAULTS_PROFILE, sourceBytes: sourceBytes.length, outputBytes: outputBytes.length, appendedBytes: append.bytes.length, sourcePrefixPreserved: true, onlyCatalogChanged: true, revisionCount: output.revisions.length, groupCount: after.groups.length, visible: Object.freeze([...after.visible]), catalogReference: referenceText(output.root) });
  } catch (error) {
    if (error?.code === 'INVALID_PDF_LAYER_DEFAULTS') throw error;
    throw invalidOutput();
  }
}

export function inspectPdfLayerDefaults(sourceBytes, outputBytes, requestValue) {
  const request = normalizePdfLayerDefaults(requestValue);
  if (sourceSha256(sourceBytes) !== request.sourceSha256) throw failure('INVALID_PDF_LAYER_DEFAULTS', 'The source digest does not match source bytes.');
  const source = parseSource(sourceBytes); rejectHazards(source, source.root); const before = inspectOptionalContent(source); const beforePages = pageSnapshot(source, before, sourceBytes); const append = canonicalAppend(sourceBytes, source, before, request);
  return verify(sourceBytes, outputBytes, request, source, before, beforePages, append);
}

export function writePdfLayerDefaults(sourceBytes, requestValue) {
  const request = normalizePdfLayerDefaults(requestValue);
  if (sourceSha256(sourceBytes) !== request.sourceSha256) throw failure('INVALID_PDF_LAYER_DEFAULTS', 'The source digest does not match source bytes.');
  const source = parseSource(sourceBytes);
  if (source.revisions.length >= CLASSIC_PDF_STRUCTURE_LIMITS.maxRevisions) throw unsupported();
  const before = inspectOptionalContent(source); rejectHazards(source, source.root); const beforePages = pageSnapshot(source, before, sourceBytes); const append = canonicalAppend(sourceBytes, source, before, request);
  const bytes = Buffer.concat([sourceBytes, append.bytes]);
  return Object.freeze({ bytes, proof: verify(sourceBytes, bytes, request, source, before, beforePages, append) });
}

export const writeIncrementalPdfLayerDefaults = writePdfLayerDefaults;
export const inspectIncrementalPdfLayerDefaults = inspectPdfLayerDefaults;
