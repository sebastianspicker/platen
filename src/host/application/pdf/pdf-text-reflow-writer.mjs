import { createHash } from 'node:crypto';
import { parseClassicPdfStructure, resolveClassicPdfObject } from './pdf-classic-structure.mjs';
import { pdfDictionary, serializePdfValue } from './pdf-classic-syntax.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { tokenizePdfContentStream } from './pdf-content-stream-tokenizer.mjs';
import { resolvePdfPageTree } from './pdf-page-tree-resolver.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import { normalizePdfTextReflowRequest, PDF_TEXT_REFLOW_PROFILE } from './pdf-text-reflow-contract.mjs';

const UNSAFE_KEYS = new Set(['A', 'AA', 'AcroForm', 'Annots', 'ByteRange', 'Collection', 'Encrypt', 'EmbeddedFiles', 'F', 'Filespec', 'FS', 'JS', 'JavaScript', 'MarkInfo', 'Metadata', 'Names', 'OC', 'OCProperties', 'OpenAction', 'ParentTree', 'Outlines', 'Perms', 'PresSteps', 'RoleMap', 'StructParents', 'StructTreeRoot', 'URI', 'XFA']);
const UNSAFE_TYPES = new Set(['Action', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Sig', 'StructElem', 'StructTreeRoot']);
const UNSAFE_ACTIONS = new Set(['GoTo', 'GoToR', 'GoToE', 'Launch', 'URI', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript', 'SetOCGState', 'Rendition']);
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'PDF is outside the bounded text-reflow subset.') { throw failure('UNSUPPORTED_PDF_TEXT_REFLOW', message); }
function invalidOutput(message = 'PDF text-reflow output proof failed.') { throw failure('INVALID_PDF_TEXT_REFLOW_OUTPUT', message); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function sameRef(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function refText(reference) { return `${reference.object} ${reference.generation} R`; }
function streamBytes(source, stream) { if (!stream?.stream || !Number.isSafeInteger(stream.streamStart) || !Number.isSafeInteger(stream.streamLength) || stream.streamStart < 0 || stream.streamLength < 0 || stream.streamStart + stream.streamLength > source.length) unsupported(); return source.subarray(stream.streamStart, stream.streamStart + stream.streamLength); }
function rejectUnsafe(value) {
  if (value?.type !== 'dict') return; const entries = value.entries;
  if ([...entries.keys()].some((key) => UNSAFE_KEYS.has(key))) unsupported('Active, tagged, form, metadata, layer, or signature features are unsupported.');
  const type = entries.get('Type'); const subtype = entries.get('Subtype'); const action = entries.get('S');
  if (type?.type === 'name' && UNSAFE_TYPES.has(type.value) || subtype?.type === 'name' && ['Widget', 'XML'].includes(subtype.value) || entries.get('FT')?.type === 'name' || action?.type === 'name' && UNSAFE_ACTIONS.has(action.value)) unsupported();
}
function countReferences(value, counts) { if (value?.type === 'ref') { const key = refText(value); counts.set(key, (counts.get(key) ?? 0) + 1); return; } if (value?.type === 'array') { for (const child of value.values) countReferences(child, counts); } else if (value?.type === 'dict') for (const child of value.entries.values()) countReferences(child, counts); }
function checkedSource(source, request) {
  if (!Buffer.isBuffer(source) || source.buffer instanceof SharedArrayBuffer || source.length < 64 || source.length > 64 * 1024 * 1024 || digest(source) !== request.sourceSha256) unsupported('The source digest or byte envelope is invalid.');
  let structure; try { structure = parseClassicPdfStructure(source); } catch { unsupported('Only classic-xref PDFs are admitted.'); }
  if (structure.revisions.length !== 1) unsupported('Only one unsigned source revision is admitted.');
  try { rejectUnsafe(pdfDictionary(resolveClassicPdfObject(structure, structure.root).value)); visitPdfObjects(structure, (object) => rejectUnsafe(object.value)); } catch (error) { if (error?.code === 'UNSUPPORTED_PDF_TEXT_REFLOW') throw error; unsupported(); }
  return structure;
}
function tokenize(source, content) {
  if (content.stream.value.entries.has('Filter') || content.stream.value.entries.has('DecodeParms')) unsupported('Filtered content streams are unsupported.');
  let result; try { result = tokenizePdfContentStream({ sourceBytes: source, stream: content.stream }); } catch { unsupported('Content stream syntax is malformed.'); }
  let textDepth = 0;
  for (let index = 0; index < result.tokens.length; index += 1) {
    const token = result.tokens[index];
    if (['array-start', 'array-end', 'dict-start', 'dict-end'].includes(token.type)) unsupported('Content arrays and dictionaries are unsupported.');
    if (token.type === 'operator' && token.value === 'BT') { if (textDepth !== 0) unsupported('Nested text objects are unsupported.'); textDepth = 1; continue; }
    if (token.type === 'operator' && token.value === 'ET') { if (textDepth !== 1) unsupported('Text objects are unbalanced.'); textDepth = 0; continue; }
    if (token.type === 'string' && (textDepth !== 1 || token.format !== 'literal' || result.tokens[index + 1]?.type !== 'operator' || result.tokens[index + 1]?.value !== 'Tj')) unsupported('Only literal strings shown by Tj inside a text object are admitted.');
    if (token.type === 'operator' && ['Tj', 'T*'].includes(token.value) && textDepth !== 1) unsupported('Text operators must remain inside one balanced text object.');
    if (token.type === 'operator' && ['TJ', "'", '"', 'BMC', 'BDC', 'EMC', 'MP', 'DP'].includes(token.value)) unsupported('Implicit-position, array, or marked-content text is unsupported.');
  }
  if (textDepth !== 0) unsupported('Text objects are unbalanced.');
  return result;
}
function canonicalParagraph(lines) {
  let blank = false; const parts = [];
  for (const line of lines) { const part = line.replace(/ +$/u, ''); if (!part) { blank = true; continue; } if (blank || part.trim() !== part || /\s{2,}/u.test(part)) unsupported('Source line slots are not canonical paragraph text.'); parts.push(part); }
  if (!parts.length) unsupported('The selected paragraph is empty.'); return parts.join(' ');
}
function wrapParagraph(value, width, count) {
  const lines = []; let current = '';
  for (const word of value.split(' ')) { if (word.length > width) unsupported('A replacement word exceeds the fixed line width.'); const candidate = current ? `${current} ${word}` : word; if (candidate.length <= width) current = candidate; else { lines.push(current); current = word; } }
  if (current) lines.push(current); if (lines.length > count) unsupported('The replacement does not fit the preallocated line slots.');
  return Object.freeze(Array.from({ length: count }, (_, index) => (lines[index] ?? '').padEnd(width, ' ')));
}
function pageProof(page) { return Object.freeze({ reference: refText(page.reference), mediaBox: Object.freeze([...page.mediaBox]), cropBox: Object.freeze([...page.cropBox]), rotate: page.rotate, resources: page.resources ? serializePdfValue(page.resources) : null }); }
function collectState(source, structure, request) {
  let tree; try { tree = resolvePdfPageTree({ structure, limits: { maxPages: 10_000 } }); } catch { unsupported('The page tree is unsupported.'); }
  const selected = tree.pages[request.page - 1]; if (!selected || selected.contents.length !== 1 || !sameRef(selected.contents[0].reference, request.streamRef)) unsupported('The selected page and stream locator do not match.');
  const contents = new Map(); const uses = new Set(); const referenceUses = new Map(); visitPdfObjects(structure, (object) => countReferences(object.value, referenceUses));
  for (const page of tree.pages) for (const content of page.contents) { const key = refText(content.reference); if (uses.has(key)) unsupported('Shared content streams are unsupported.'); uses.add(key); const bytes = Buffer.from(streamBytes(source, content.stream)); contents.set(key, Object.freeze({ content, bytes, tokens: tokenize(source, content).tokens })); }
  for (const key of contents.keys()) if (referenceUses.get(key) !== 1) unsupported('Content streams must have one unambiguous graph reference.');
  const target = contents.get(refText(request.streamRef)); const slots = [];
  for (let index = 0; index < request.lineTokenIndices.length; index += 1) {
    const tokenIndex = request.lineTokenIndices[index]; const token = target?.tokens[tokenIndex]; const following = target?.tokens[tokenIndex + 1];
    if (token?.type !== 'string' || token.format !== 'literal' || token.bytes.length !== request.lineWidth || following?.type !== 'operator' || following.value !== 'Tj') unsupported('A line locator does not identify a fixed-width literal Tj slot.');
    const raw = target.bytes.subarray(token.start, token.end); if (raw.length !== request.lineWidth + 2 || raw[0] !== 0x28 || raw.at(-1) !== 0x29 || raw.includes(0x5c) || token.bytes.some((byte) => byte < 0x20 || byte > 0x7e)) unsupported('Line slots must be unescaped printable ASCII literals.');
    if (index > 0) { const previous = request.lineTokenIndices[index - 1]; if (tokenIndex !== previous + 3 || target.tokens[previous + 2]?.type !== 'operator' || target.tokens[previous + 2].value !== 'T*') unsupported('Line slots must be one contiguous T*-separated paragraph block.'); }
    slots.push(Object.freeze({ token, text: token.bytes.toString('ascii') }));
  }
  const original = canonicalParagraph(slots.map((slot) => slot.text)); if (digest(Buffer.from(original, 'ascii')) !== request.originalTextSha256) unsupported('The paragraph locator is stale.');
  return Object.freeze({ structure, tree, selected, contents, target, slots: Object.freeze(slots), original, outputLines: wrapParagraph(request.replacementText, request.lineWidth, slots.length) });
}
function build(source, request, state) {
  const rewritten = Buffer.from(state.target.bytes); state.slots.forEach((slot, index) => rewritten.set(Buffer.from(state.outputLines[index], 'ascii'), slot.token.start + 1));
  const transaction = planPdfObjectTransaction({ sourceBytes: source, sourceStructure: state.structure, updates: [{ reference: state.target.content.reference, value: state.target.content.stream.value, streamBytes: rewritten }], additions: [], info: { kind: 'preserve' }, changingId: null });
  return Object.freeze({ bytes: Buffer.concat([source, transaction.revision.bytes]), rewritten, transaction });
}
function proof(source, output, request, state, built) {
  if (!Buffer.isBuffer(output) || !output.subarray(0, source.length).equals(source)) invalidOutput('The source prefix changed.');
  let verified; try { verified = verifyPdfIncrementalRevision({ sourceBytes: source, outputBytes: output, sourceStructure: state.structure, expectedRevision: built.transaction.revision }).outputStructure; } catch { invalidOutput(); }
  let tree; try { tree = resolvePdfPageTree({ structure: verified.xrefFlavor === 'classic' ? parseClassicPdfStructure(output) : verified, limits: { maxPages: 10_000 } }); } catch { invalidOutput(); }
  if (tree.pageCount !== state.tree.pageCount) invalidOutput();
  for (let pageIndex = 0; pageIndex < tree.pages.length; pageIndex += 1) { if (JSON.stringify(pageProof(tree.pages[pageIndex])) !== JSON.stringify(pageProof(state.tree.pages[pageIndex]))) invalidOutput('Page geometry or resources changed.'); for (const content of tree.pages[pageIndex].contents) { const before = state.contents.get(refText(content.reference)); if (!before) invalidOutput(); const expected = sameRef(content.reference, request.streamRef) ? built.rewritten : before.bytes; if (!streamBytes(output, content.stream).equals(expected)) invalidOutput('An unrelated content stream changed.'); } }
  return Object.freeze({ profile: PDF_TEXT_REFLOW_PROFILE, sourceSha256: digest(source), outputSha256: digest(output), sourcePrefixPreserved: true, page: request.page, streamReference: refText(request.streamRef), lineCount: state.slots.length, lineWidth: request.lineWidth, originalTextSha256: request.originalTextSha256, replacementTextSha256: digest(Buffer.from(request.replacementText, 'ascii')), fixedSlotReflow: true, textPositionsPreserved: true, typographyPreserved: true, streamByteLengthPreserved: built.rewritten.length === state.target.bytes.length, revisionCount: verified.revisions.length, changedObjectCount: 1 });
}
export function writePdfTextReflow(sourceBytes, requestValue) { const request = normalizePdfTextReflowRequest(requestValue); const state = collectState(sourceBytes, checkedSource(sourceBytes, request), request); const built = build(sourceBytes, request, state); return Object.freeze({ bytes: built.bytes, proof: proof(sourceBytes, built.bytes, request, state, built) }); }
export function inspectPdfTextReflow(sourceBytes, outputBytes, requestValue) { const request = normalizePdfTextReflowRequest(requestValue); const state = collectState(sourceBytes, checkedSource(sourceBytes, request), request); const built = build(sourceBytes, request, state); if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(built.bytes)) invalidOutput(); return proof(sourceBytes, outputBytes, request, state, built); }
