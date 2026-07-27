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
import { PDF_PRINTER_MARKS_PROFILE, normalizePdfPrinterMarks } from './pdf-printer-marks-contract.mjs';

export { PDF_PRINTER_MARKS_PROFILE };

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const UNSAFE_KEYS = new Set(['A', 'AA', 'AcroForm', 'AF', 'Annots', 'Collection', 'Encrypt', 'EmbeddedFiles', 'Filespec', 'JS', 'JavaScript', 'Metadata', 'Names', 'OCProperties', 'OpenAction', 'Outlines', 'Perms', 'PieceInfo', 'Sig', 'StructTreeRoot', 'XFA']);
const UNSAFE_TYPES = new Set(['Action', 'Annot', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Sig', 'StructElem']);
const MIN_MARGIN = 4;

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'PDF is outside the supported bounded printer-marks subset.') { return failure('UNSUPPORTED_PDF_PRINTER_MARKS', message); }
function invalidOutput(message = 'PDF printer-marks output proof failed.') { return failure('INVALID_PDF_PRINTER_MARKS_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameReference(a, b) { return a?.object === b?.object && a?.generation === b?.generation; }
function key(reference) { return `${reference.object}:${reference.generation}`; }

function rejectUnsafe(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value.type === 'dict') {
    const type = value.entries.get('Type');
    if (type?.type === 'name' && UNSAFE_TYPES.has(type.value)) throw unsupported('Active, signed, tagged, layered, or attached PDF content is unsupported.');
    for (const [name, child] of value.entries) {
      if (UNSAFE_KEYS.has(name) || name === 'FT' || name === 'StructParents' || name === 'ParentTree' || name === 'RoleMap') throw unsupported('Active, signed, tagged, layered, or attached PDF content is unsupported.');
      rejectUnsafe(child, seen);
    }
  } else if (value.type === 'array') for (const child of value.values) rejectUnsafe(child, seen);
}

function numberBox(value, name) {
  if (value?.type !== 'array' || value.values.length !== 4 || value.values.some((entry) => entry?.type !== 'number' || !Number.isFinite(entry.value))) throw unsupported(`${name} must be an explicit finite four-number array.`);
  const box = value.values.map((entry) => entry.value);
  if (!(box[2] > box[0] && box[3] > box[1])) throw unsupported(`${name} must have positive dimensions.`);
  return Object.freeze(box);
}

function sameValue(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'dict') return a.entries.size === b.entries.size && [...a.entries].every(([k, v]) => sameValue(v, b.entries.get(k)));
  if (a.type === 'array') return a.values.length === b.values.length && a.values.every((v, i) => sameValue(v, b.values[i]));
  if (a.type === 'ref') return sameReference(a, b);
  if (a.type === 'string') return Buffer.from(a.bytes).equals(Buffer.from(b.bytes));
  return a.value === b.value;
}

function fmt(value) { return Number(value.toFixed(4)).toString(); }
function marksFor(trim, bleed) {
  const margins = [trim[0] - bleed[0], trim[1] - bleed[1], bleed[2] - trim[2], bleed[3] - trim[3]];
  if (margins.some((margin) => !Number.isFinite(margin) || margin < MIN_MARGIN)) throw unsupported('TrimBox must be strictly inside BleedBox with enough margin for marks.');
  const gap = 1;
  const length = Math.min(18, Math.max(1, (Math.min(...margins) - 2) / 2));
  const x0 = trim[0]; const y0 = trim[1]; const x1 = trim[2]; const y1 = trim[3];
  const lines = [
    [x0 - gap - length, y1 + gap, x0 - gap, y1 + gap], [x0 - gap, y1 + gap, x0 - gap, y1 + gap + length],
    [x1 + gap, y1 + gap, x1 + gap + length, y1 + gap], [x1 + gap, y1 + gap, x1 + gap, y1 + gap + length],
    [x0 - gap - length, y0 - gap, x0 - gap, y0 - gap], [x0 - gap, y0 - gap - length, x0 - gap, y0 - gap],
    [x1 + gap, y0 - gap, x1 + gap + length, y0 - gap], [x1 + gap, y0 - gap - length, x1 + gap, y0 - gap],
  ];
  if (lines.some((line) => line.some((value, index) => {
    const horizontal = index % 2 === 0;
    return horizontal ? value < bleed[0] || value > bleed[2] : value < bleed[1] || value > bleed[3];
  }))) throw unsupported('Crop marks would fall outside BleedBox.');
  const content = Buffer.from(`q\n0 G\n0 g\n0.5 w\n0 J\n${lines.map((line) => `${fmt(line[0])} ${fmt(line[1])} m ${fmt(line[2])} ${fmt(line[3])} l S`).join('\n')}\nQ\n`, 'latin1');
  return Object.freeze({ content, lines: Object.freeze(lines.map((line) => Object.freeze(line))), gap, length });
}

function sourceState(sourceBytes, request) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 32 || sourceBytes.length > MAX_SOURCE_BYTES || digest(sourceBytes) !== request.sourceSha256) throw failure('INVALID_PDF_PRINTER_MARKS', 'The source digest does not match source bytes.');
  let structure;
  try { structure = parsePdfStructure(sourceBytes); } catch { throw unsupported(); }
  if (structure.xrefFlavor !== 'classic' || structure.revisions.length !== 1 || structure.id || structure.info || structure.revisions[0].trailer.has('Encrypt')) throw unsupported('Only passive unsigned single-revision classic PDFs are supported.');
  try { visitPdfObjects(structure, (object) => rejectUnsafe(object.value)); } catch (error) { if (error?.code === 'UNSUPPORTED_PDF_PRINTER_MARKS') throw error; throw unsupported(); }
  const tree = resolvePdfPageTree({ structure: parseClassicPdfStructure(sourceBytes), limits: { maxDepth: 64, maxNodes: 10_000, maxPages: 10_000 } });
  const pagesObject = resolvePdfObject(structure, tree.pagesReference); const pagesDict = pdfDictionary(pagesObject.value);
  const kids = pagesDict.get('Kids'); if (kids?.type !== 'array' || kids.values.length !== tree.pageCount || kids.values.some((entry, i) => !sameReference(pdfReference(entry), tree.pages[i].reference))) throw unsupported('Only direct, non-aliased page trees are supported.');
  const targetPages = [];
  for (const pageNumber of request.pages) {
    const page = tree.pages[pageNumber - 1]; if (!page) throw failure('INVALID_PDF_PRINTER_MARKS', 'A selected page is outside the source page count.');
    const entries = pdfDictionary(page.page.value); const media = numberBox(entries.get('MediaBox'), 'MediaBox'); const crop = numberBox(entries.get('CropBox'), 'CropBox'); const bleed = numberBox(entries.get('BleedBox'), 'BleedBox'); const trim = numberBox(entries.get('TrimBox'), 'TrimBox');
    if (media[0] > crop[0] || media[1] > crop[1] || media[2] < crop[2] || media[3] < crop[3] || media[0] > bleed[0] || media[1] > bleed[1] || media[2] < bleed[2] || media[3] < bleed[3] || crop[0] > bleed[0] || crop[1] > bleed[1] || crop[2] < bleed[2] || crop[3] < bleed[3] || bleed[0] >= trim[0] || bleed[1] >= trim[1] || bleed[2] <= trim[2] || bleed[3] <= trim[3]) throw unsupported('Page boxes must be explicit, finite, and nested MediaBox >= CropBox >= BleedBox > TrimBox.');
    targetPages.push(Object.freeze({ pageNumber, reference: page.reference, media, crop, bleed, trim, marks: marksFor(trim, bleed) }));
  }
  return Object.freeze({ structure, tree, targetPages });
}

function foundationRequest(request, targets) { return Object.freeze({ profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE, sourceSha256: request.sourceSha256, edits: Object.freeze(targets.map(({ pageNumber, marks }) => Object.freeze({ page: pageNumber, position: 'append', content: marks.content }))) }); }

function verify(sourceBytes, outputBytes, request, state, foundation) {
  try {
    if (!Buffer.isBuffer(outputBytes) || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput('Source prefix was not preserved.');
    const output = parsePdfStructure(outputBytes); if (output.revisions.length !== 2) throw invalidOutput();
    const foundationProof = inspectPageContentFoundation(sourceBytes, outputBytes, foundation); if (foundationProof.outputSha256 !== digest(outputBytes)) throw invalidOutput();
    const outputTree = resolvePdfPageTree({ structure: parseClassicPdfStructure(outputBytes), limits: { maxDepth: 64, maxNodes: 10_000, maxPages: 10_000 } });
    const targets = new Set(request.pages);
    for (const before of state.tree.pages) {
      const after = outputTree.pages[before.index]; if (!after || !sameReference(before.reference, after.reference)) throw invalidOutput();
      const beforeEntries = pdfDictionary(before.page.value); const afterEntries = pdfDictionary(after.page.value);
      for (const [name, value] of beforeEntries) if (name !== 'Contents' && !sameValue(value, afterEntries.get(name))) throw invalidOutput(`Original page ${name} changed.`);
      if (!targets.has(before.index + 1) && !sameValue(before.page.value, after.page.value)) throw invalidOutput('A non-target page changed.');
    }
    for (const [index, target] of state.targetPages.entries()) {
      const edit = foundationProof.edits[index]; if (!edit || edit.page !== target.pageNumber || edit.sha256 !== digest(target.marks.content) || edit.operatorCounts.S !== 8) throw invalidOutput();
    }
    return Object.freeze({ profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: digest(sourceBytes), outputSha256: digest(outputBytes), sourceBytes: sourceBytes.length, outputBytes: outputBytes.length, sourcePrefixPreserved: true, revisionCount: output.revisions.length, pageCount: state.tree.pageCount, pages: Object.freeze(state.targetPages.map(({ pageNumber, reference, media, crop, bleed, trim, marks }, index) => Object.freeze({ page: pageNumber, reference: `${reference.object} ${reference.generation} R`, mediaBox: media, cropBox: crop, bleedBox: bleed, trimBox: trim, operatorBytes: marks.content.length, operatorSha256: digest(marks.content), lines: marks.lines, foundationEdit: foundationProof.edits[index] }))), originalContentStreams: foundationProof.originalContentStreams, resourcesAdded: false, onlySelectedPagesChanged: true });
  } catch (error) { if (error?.code === 'INVALID_PDF_PRINTER_MARKS_OUTPUT') throw error; throw invalidOutput(); }
}

export function writePdfPrinterMarks(sourceBytes, requestValue) {
  const request = normalizePdfPrinterMarks(requestValue); const state = sourceState(sourceBytes, request); const foundation = foundationRequest(request, state.targetPages);
  const result = writePageContentFoundation(sourceBytes, foundation); return Object.freeze({ bytes: result.bytes, proof: verify(sourceBytes, result.bytes, request, state, foundation) });
}
export function inspectPdfPrinterMarks(sourceBytes, outputBytes, requestValue) { const request = normalizePdfPrinterMarks(requestValue); const state = sourceState(sourceBytes, request); return verify(sourceBytes, outputBytes, request, state, foundationRequest(request, state.targetPages)); }
export const writeIncrementalPdfPrinterMarks = writePdfPrinterMarks;
export const inspectIncrementalPdfPrinterMarks = inspectPdfPrinterMarks;
