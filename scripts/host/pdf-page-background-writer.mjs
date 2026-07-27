import { createHash } from 'node:crypto';

import { pdfDictionary, pdfReference } from './pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import { resolvePdfPageTree } from './pdf-page-tree-resolver.mjs';
import {
  PDF_PAGE_CONTENT_FOUNDATION_PROFILE,
  collectPageContentFoundationState,
  inspectPageContentFoundation,
  writePageContentFoundation,
} from './pdf-page-content-foundation.mjs';
import {
  PDF_PAGE_BACKGROUND_LIMITS,
  PDF_PAGE_BACKGROUND_PROFILE,
  normalizePdfPageBackground,
} from './pdf-page-background-contract.mjs';

const UNSAFE_KEYS = new Set(['A', 'AA', 'AcroForm', 'AF', 'Collection', 'Encrypt', 'EmbeddedFiles', 'Filespec', 'JS', 'JavaScript', 'Metadata', 'Names', 'OCProperties', 'OpenAction', 'Outlines', 'Perms', 'PieceInfo', 'Sig', 'StructTreeRoot', 'XFA', 'Dests', 'Dest', 'Lang', 'ViewerPreferences', 'MarkInfo', 'Tabs', 'StructParents', 'ParentTree', 'RoleMap']);
const UNSAFE_TYPES = new Set(['Action', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Sig', 'StructElem', 'XRef', 'ObjStm']);
const PASSIVE_ANNOTATIONS = new Set(['Text', 'FreeText', 'Stamp', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Circle', 'Square', 'Line', 'Ink', 'Popup']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function invalidOutput(message = 'PDF page-background output proof failed.') { return failure('INVALID_PDF_PAGE_BACKGROUND_OUTPUT', message); }
function unsupported(message = 'PDF is outside the supported bounded solid page-background subset.') { return failure('UNSUPPORTED_PDF_PAGE_BACKGROUND', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameReference(a, b) { return a?.object === b?.object && a?.generation === b?.generation; }
function referenceText(reference) { return `${reference.object} ${reference.generation} R`; }

function sameValue(a, b) {
  if (!a || !b || a.type !== b.type) return a === b;
  if (a.type === 'dict') return a.entries.size === b.entries.size && [...a.entries].every(([key, value]) => sameValue(value, b.entries.get(key)));
  if (a.type === 'array') return a.values.length === b.values.length && a.values.every((value, index) => sameValue(value, b.values[index]));
  if (a.type === 'ref') return sameReference(a, b);
  if (a.type === 'string') return Buffer.from(a.bytes).equals(Buffer.from(b.bytes));
  return a.value === b.value;
}

function rejectUnsafe(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value.type !== 'dict') {
    if (value.type === 'array') value.values.forEach((child) => rejectUnsafe(child, seen));
    return;
  }
  const entries = value.entries;
  const type = entries.get('Type');
  if (type?.type === 'name' && UNSAFE_TYPES.has(type.value)) throw unsupported('Active, signed, tagged, layered, or attached PDF content is unsupported.');
  if (type?.type === 'name' && type.value === 'Annot') {
    const subtype = entries.get('Subtype');
    if (subtype?.type !== 'name' || !PASSIVE_ANNOTATIONS.has(subtype.value)
      || [...entries.keys()].some((key) => ['A', 'AA', 'Dest', 'JS', 'JavaScript', 'OC', 'OCMD', 'AS', 'FS'].includes(key))) throw unsupported('Only inert annotation dictionaries are supported.');
  } else {
    for (const name of entries.keys()) if (UNSAFE_KEYS.has(name)) throw unsupported('Active, signed, tagged, layered, or attached PDF content is unsupported.');
  }
  for (const child of entries.values()) rejectUnsafe(child, seen);
}

function numberBox(value, name) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry?.type !== 'number' || !Number.isFinite(entry.value))) throw unsupported(`${name} must be an explicit finite four-number array.`);
  const box = value.values.map((entry) => entry.value);
  if (box.some((entry) => Math.abs(entry) > 1_000_000_000)) throw unsupported(`${name} coordinates exceed the bounded authoring range.`);
  if (!(box[2] > box[0] && box[3] > box[1]) || box[2] - box[0] < 0.000001 || box[3] - box[1] < 0.000001) throw unsupported(`${name} must have positive bounded dimensions.`);
  return Object.freeze(box);
}

function fmt(value) {
  const normalized = Object.is(value, -0) ? 0 : Number(value.toFixed(6));
  return String(normalized);
}

function backgroundStream(box, color) {
  const [x0, y0, x1, y1] = box;
  return Buffer.from(`q\n${fmt(color.r)} ${fmt(color.g)} ${fmt(color.b)} rg\n${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re\nf\nQ\n`, 'latin1');
}

function parseState(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 32 || sourceBytes.length > PDF_PAGE_BACKGROUND_LIMITS.maxSourceBytes || digest(sourceBytes) !== request.sourceSha256) throw failure('INVALID_PDF_PAGE_BACKGROUND', 'The source digest does not match source bytes.');
  let structure;
  try { structure = parsePdfStructure(sourceBytes); } catch { throw unsupported(); }
  if (structure.xrefFlavor !== 'classic' || structure.revisions.length !== 1 || structure.id || structure.info || structure.revisions[0].trailer.has('Encrypt')) throw unsupported('Only passive unsigned single-revision classic PDFs without an ID are supported.');
  try { visitPdfObjects(structure, (object) => rejectUnsafe(object.value)); } catch (error) { if (error?.code === 'UNSUPPORTED_PDF_PAGE_BACKGROUND') throw error; throw unsupported(); }
  const tree = resolvePdfPageTree({ structure: parseClassicPdfStructure(sourceBytes), limits: { maxDepth: 64, maxNodes: 10_000, maxPages: PDF_PAGE_BACKGROUND_LIMITS.maxPages } });
  const pagesObject = pdfDictionary(resolvePdfObject(structure, tree.pagesReference).value);
  const kids = pagesObject.get('Kids');
  if (kids?.type !== 'array' || kids.values.length !== tree.pageCount || kids.values.some((entry, index) => !sameReference(pdfReference(entry), tree.pages[index].reference))) throw unsupported('Only direct, non-aliased page trees are supported.');
  const targets = request.pages.map((pageNumber) => {
    const page = tree.pages[pageNumber - 1];
    if (!page || page.rotate !== 0) throw unsupported('Selected pages must be unrotated.');
    const entries = pdfDictionary(page.page.value);
    const media = numberBox(entries.get('MediaBox'), 'MediaBox');
    const crop = numberBox(entries.get('CropBox'), 'CropBox');
    if (!media.every((value, index) => value === crop[index])) throw unsupported('Selected pages must have CropBox exactly equal to MediaBox.');
    const resources = entries.get('Resources');
    if (!resources || !['dict', 'ref'].includes(resources.type)) throw unsupported('Selected pages must have explicit resources.');
    if (resources.type === 'ref') { const resolved = resolvePdfObject(structure, resources); if (resolved.value?.type !== 'dict' || resolved.stream) throw unsupported('Selected page resources must resolve to a dictionary.'); }
    const annots = entries.get('Annots');
    if (annots !== undefined && annots.type !== 'array') throw unsupported('Annotations must be an explicit array.');
    if (annots?.values.some((entry) => { try { const object = resolvePdfObject(structure, pdfReference(entry)); const dict = pdfDictionary(object.value); return dict.get('Type')?.type !== 'name' || dict.get('Type').value !== 'Annot'; } catch { return true; } })) throw unsupported('Annotations must resolve to dictionaries.');
    return Object.freeze({ pageNumber, page, media, crop, resources: entries.get('Resources'), annots: entries.get('Annots'), stream: backgroundStream(crop, request.color) });
  });
  return Object.freeze({ structure, tree, targets });
}

function foundationRequest(request, targets) {
  return Object.freeze({ profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE, sourceSha256: request.sourceSha256,
    edits: Object.freeze(targets.map(({ pageNumber, stream }) => Object.freeze({ page: pageNumber, position: 'prepend', content: stream }))) });
}

function verify(sourceBytes, outputBytes, request, state, foundation) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput('Source prefix was not preserved.');
    const output = parsePdfStructure(outputBytes);
    if (output.xrefFlavor !== 'classic' || output.revisions.length !== 2 || output.id || output.info) throw invalidOutput('Output revision or identity policy changed.');
    const outputTree = resolvePdfPageTree({ structure: parseClassicPdfStructure(outputBytes), limits: { maxDepth: 64, maxNodes: 10_000, maxPages: PDF_PAGE_BACKGROUND_LIMITS.maxPages } });
    if (outputTree.pageCount !== state.tree.pageCount || !sameReference(outputTree.pagesReference, state.tree.pagesReference)) throw invalidOutput('Page tree changed.');
    const targetByPage = new Map(state.targets.map((target) => [target.pageNumber, target]));
    const expectedOriginal = new Map(state.tree.pages.map((page) => [page.index + 1, page.contents.map((content) => content.reference)]));
    const inserted = new Set();
    for (const before of state.tree.pages) {
      const pageNumber = before.index + 1; const after = outputTree.pages[before.index];
      if (!after || !sameReference(before.reference, after.reference)) throw invalidOutput('Page reference changed.');
      const beforeEntries = pdfDictionary(before.page.value); const afterEntries = pdfDictionary(after.page.value);
      for (const [name, value] of beforeEntries) if (name !== 'Contents' && !sameValue(value, afterEntries.get(name))) throw invalidOutput(`Original page ${name} changed.`);
      if (!targetByPage.has(pageNumber) && !sameValue(before.page.value, after.page.value)) throw invalidOutput('An unselected page changed.');
      const observed = after.contents.map((content) => content.reference);
      const original = expectedOriginal.get(pageNumber) ?? [];
      if (targetByPage.has(pageNumber)) {
        if (observed.length !== original.length + 1 || !observed.slice(1).every((ref, index) => sameReference(ref, original[index]))) throw invalidOutput('Background stream was not prepended exactly once.');
        const stream = after.contents[0]; const bytes = outputBytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength);
        if (!bytes.equals(targetByPage.get(pageNumber).stream) || stream.streamLength !== bytes.length) throw invalidOutput('Background stream bytes changed.');
        inserted.add(referenceText(stream.reference));
        const streamEntries = pdfDictionary(stream.stream.value); if (streamEntries.size !== 1 || streamEntries.get('Length')?.value !== bytes.length) throw invalidOutput('Background stream dictionary changed.');
      } else if (observed.length !== original.length || !observed.every((ref, index) => sameReference(ref, original[index]))) throw invalidOutput('Unselected content sequence changed.');
    }
    for (const content of foundation.state?.contentStreams?.values?.() ?? []) {
      const stream = resolvePdfObject(output, content.reference); const bytes = outputBytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength);
      if (!stream.stream || stream.streamLength !== content.streamLength || !bytes.equals(sourceBytes.subarray(content.streamStart, content.streamStart + content.streamLength))) throw invalidOutput('Original content stream changed.');
    }
    return Object.freeze({ profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: digest(sourceBytes), outputSha256: digest(outputBytes), sourceBytes: sourceBytes.length, outputBytes: outputBytes.length, sourcePrefixPreserved: true, revisionCount: output.revisions.length, pageCount: state.tree.pageCount, pages: Object.freeze(state.targets.map((target, index) => Object.freeze({ page: target.pageNumber, reference: referenceText(target.page.reference), mediaBox: target.media, cropBox: target.crop, color: request.color, stream: Object.freeze({ reference: [...inserted][index] ?? '', bytes: target.stream.length, sha256: digest(target.stream) }), foundationEdit: foundation.proof?.edits?.[index] ?? null }))), originalContentStreams: foundation.proof?.originalContentStreams ?? [], onlySelectedPagesChanged: true, resourcesPreserved: true, annotationsPreserved: true, idPolicy: 'absent' });
  } catch (error) { if (error?.code === 'INVALID_PDF_PAGE_BACKGROUND_OUTPUT') throw error; throw invalidOutput(); }
}

export function writePdfPageBackground(sourceBytes, requestValue) {
  const request = normalizePdfPageBackground(requestValue); const state = parseState(sourceBytes, request); const foundationRequestValue = foundationRequest(request, state.targets);
  const foundation = writePageContentFoundation(sourceBytes, foundationRequestValue);
  const proof = verify(sourceBytes, foundation.bytes, request, state, { ...foundation, state: collectPageContentFoundationState(sourceBytes, foundationRequestValue) });
  return Object.freeze({ bytes: foundation.bytes, proof });
}

export function inspectPdfPageBackground(sourceBytes, outputBytes, requestValue) {
  const request = normalizePdfPageBackground(requestValue); const state = parseState(sourceBytes, request); const foundationRequestValue = foundationRequest(request, state.targets);
  const foundationState = collectPageContentFoundationState(sourceBytes, foundationRequestValue);
  let foundationProof;
  try { foundationProof = inspectPageContentFoundation(sourceBytes, outputBytes, foundationRequestValue); } catch { throw invalidOutput(); }
  return verify(sourceBytes, outputBytes, request, state, { proof: foundationProof, state: foundationState });
}

export const writeIncrementalPdfPageBackground = writePdfPageBackground;
export const inspectIncrementalPdfPageBackground = inspectPdfPageBackground;
