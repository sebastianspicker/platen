import { createHash } from 'node:crypto';
import {
  parsePdfStructure,
  parseClassicPdfStructure,
  resolvePdfObject,
} from './pdf-classic-structure.mjs';
import { pdfDictionary, serializePdfValue } from './pdf-classic-syntax.mjs';
import { planPdfObjectTransaction } from './pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from './pdf-classic-incremental-revision.mjs';
import { tokenizePdfContentStream } from './pdf-content-stream-tokenizer.mjs';
import { resolvePdfPageTree } from './pdf-page-tree-resolver.mjs';
import { visitPdfObjects } from './pdf-structure-inspection.mjs';
import {
  normalizePdfTextEditRequest,
  PDF_TEXT_EDIT_PROFILE,
} from './pdf-text-edit-contract.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const UNSAFE_KEYS = new Set([
  'A', 'AA', 'AcroForm', 'Annots', 'ByteRange', 'Collection', 'Encrypt',
  'EmbeddedFiles', 'F', 'Filespec', 'FS', 'JS', 'JavaScript', 'MarkInfo',
  'Metadata', 'Names', 'OC', 'OCProperties', 'OpenAction', 'ParentTree',
  'Outlines', 'Perms', 'PresSteps', 'RoleMap', 'StructParents', 'StructTreeRoot',
  'URI', 'XFA', 'Lang',
]);
const UNSAFE_TYPES = new Set([
  'Action', 'EmbeddedFile', 'Filespec', 'OCG', 'OCMD', 'Sig', 'StructElem',
  'StructTreeRoot',
]);
const UNSAFE_SUBTYPES = new Set(['Widget', 'XML']);
const UNSAFE_ACTIONS = new Set([
  'GoTo', 'GoToR', 'GoToE', 'Launch', 'Thread', 'URI', 'Sound', 'Movie',
  'Hide', 'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript',
  'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView',
]);

function invalid(message = 'PDF text-edit request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_PDF_TEXT_EDIT';
  return error;
}
function unsupported(message = 'PDF is outside the supported bounded text-edit subset.') {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_PDF_TEXT_EDIT';
  return error;
}
function invalidOutput(message = 'PDF text-edit output proof failed.') {
  const error = new Error(message);
  error.code = 'INVALID_PDF_TEXT_EDIT_OUTPUT';
  return error;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function sameReference(left, right) {
  return left?.object === right?.object && left?.generation === right?.generation;
}
function referenceText(reference) { return `${reference.object} ${reference.generation} R`; }

function checkedRequest(value) {
  try { return normalizePdfTextEditRequest(value); }
  catch (error) { if (error?.code === 'INVALID_PDF_TEXT_EDIT') throw error; throw invalid(); }
}

function rejectUnsafeDictionary(value) {
  if (value?.type !== 'dict') return;
  const entries = value.entries;
  if ([...entries.keys()].some((key) => UNSAFE_KEYS.has(key))) throw unsupported('Active, tagged, form, metadata, or signature PDF features are unsupported.');
  const type = entries.get('Type');
  const subtype = entries.get('Subtype');
  const fieldType = entries.get('FT');
  if (type?.type === 'name' && UNSAFE_TYPES.has(type.value)) throw unsupported();
  if (subtype?.type === 'name' && UNSAFE_SUBTYPES.has(subtype.value)) throw unsupported();
  if (fieldType?.type === 'name') throw unsupported();
  const action = entries.get('S');
  if (action?.type === 'name' && UNSAFE_ACTIONS.has(action.value)) throw unsupported();
}

function checkedSource(sourceBytes, sourceSha256) {
  if (!Buffer.isBuffer(sourceBytes)
    || (typeof SharedArrayBuffer !== 'undefined' && sourceBytes.buffer instanceof SharedArrayBuffer)
    || sourceBytes.length < 5 || sourceBytes.length > 256 * 1024 * 1024) throw invalid();
  if (sourceSha256 !== undefined && (!SHA256.test(sourceSha256) || sha256(sourceBytes) !== sourceSha256)) throw invalid();
  let structure;
  try { structure = parsePdfStructure(sourceBytes); } catch { throw unsupported('The source PDF structure is not supported.'); }
  if (!Array.isArray(structure.revisions) || structure.revisions.length !== 1) throw unsupported('Prior revisions are ambiguous for text editing.');
  try {
    const catalog = resolvePdfObject(structure, structure.root);
    rejectUnsafeDictionary(pdfDictionary(catalog.value));
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_PDF_TEXT_EDIT') throw error;
    throw unsupported();
  }
  try { visitPdfObjects(structure, (object) => rejectUnsafeDictionary(object.value)); }
  catch (error) {
    if (error?.code === 'UNSUPPORTED_PDF_TEXT_EDIT') throw error;
    throw unsupported();
  }
  return structure;
}

function streamBytes(sourceBytes, stream) {
  if (!stream?.stream || !Number.isSafeInteger(stream.streamStart)
    || !Number.isSafeInteger(stream.streamLength) || stream.streamStart < 0
    || stream.streamLength < 0 || stream.streamStart + stream.streamLength > sourceBytes.length) throw unsupported();
  return sourceBytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength);
}

function scanContent(sourceBytes, stream, request, selected) {
  const entries = stream.stream.value?.entries;
  if (entries?.has('Filter') || entries?.has('DecodeParms')) throw unsupported('Filtered content streams are unsupported.');
  const bytes = streamBytes(sourceBytes, stream.stream);
  let tokenized;
  try { tokenized = tokenizePdfContentStream({ sourceBytes, stream: stream.stream }); }
  catch (error) { throw unsupported(error?.message); }
  let match = null;
  const findBytes = Buffer.from(request.find, 'ascii');
  // debug
  const replaceBytes = Buffer.from(request.replace, 'ascii');
  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index];
    if (token.type === 'array-start' || token.type === 'array-end'
      || token.type === 'dict-start' || token.type === 'dict-end') throw unsupported('Arrays and dictionaries in content streams are unsupported.');
    if (token.type === 'string') {
      if (token.format !== 'literal') throw unsupported('Hex strings are unsupported.');
      const raw = bytes.subarray(token.start, token.end);
      if (raw.length < 2 || raw[0] !== 0x28 || raw.at(-1) !== 0x29 || raw.includes(0x5c)
        || tokenized.tokens[index + 1]?.type !== 'operator'
        || tokenized.tokens[index + 1]?.value !== 'Tj') {
        throw unsupported('Only unescaped literal strings shown with Tj are supported.');
      }
      if (token.bytes.equals(findBytes)) {
        if (match) throw unsupported('The requested literal occurs more than once.');
        match = Object.freeze({ token, rawStart: token.start, rawEnd: token.end, bytes, replaceBytes });
      }
    }
    if (token.type === 'operator' && ['TJ', "'", '"', 'BMC', 'BDC', 'EMC', 'MP', 'DP'].includes(token.value)) throw unsupported('Array, marked-content, and implicit-position text operators are unsupported.');
  }
  if (selected && !match) throw unsupported('The requested literal was not found uniquely in the selected stream.');
  return Object.freeze({
    reference: stream.reference,
    stream: stream.stream,
    streamStart: stream.stream.streamStart,
    bytes: Buffer.from(bytes),
    digest: sha256(bytes),
    tokenCount: tokenized.tokens.length,
    match,
  });
}

function collectState(sourceBytes, structure, request) {
  let tree;
  const treeStructure = structure.xrefFlavor === 'classic' || structure.xrefFlavor === undefined
    ? parseClassicPdfStructure(sourceBytes) : structure;
  try { tree = resolvePdfPageTree({ structure: treeStructure }); } catch { throw unsupported('The PDF page tree is unsupported.'); }
  const selected = tree.pages[request.page - 1];
  if (!selected || selected.contents.length !== 1) throw unsupported('The selected page must contain exactly one content stream.');
  const use = new Map();
  const contents = new Map();
  for (const page of tree.pages) {
    for (const content of page.contents) {
      const key = referenceText(content.reference);
      use.set(key, (use.get(key) ?? 0) + 1);
      if (use.get(key) > 1) throw unsupported('Content streams may not be shared or aliased.');
      const scan = scanContent(sourceBytes, content, request, sameReference(content.reference, selected.contents[0].reference));
      contents.set(key, Object.freeze({ ...scan, reference: content.reference }));
    }
  }
  const target = contents.get(referenceText(selected.contents[0].reference));
  if (!target?.match) throw unsupported('The requested literal was not found uniquely in the selected stream.');
  return Object.freeze({ structure, tree, selected, target, contents, treeStructure });
}

function changedId(sourceBytes, request) {
  const hash = createHash('sha256').update('Platen text edit ID v1\0', 'utf8');
  hash.update(createHash('sha256').update(sourceBytes).digest());
  hash.update(`${request.page}:`, 'utf8');
  hash.update(request.find, 'ascii');
  hash.update('\0', 'utf8');
  hash.update(request.replace, 'ascii');
  return hash.digest().subarray(0, 16);
}

function pageProof(page) {
  return Object.freeze({
    reference: referenceText(page.reference), mediaBox: Object.freeze([...page.mediaBox]),
    cropBox: Object.freeze([...page.cropBox]), rotate: page.rotate,
    resources: page.resources ? serializePdfValue(page.resources) : null,
  });
}

function outputProof(sourceBytes, outputBytes, state, transaction, writtenBytes, request) {
  if (!Buffer.isBuffer(outputBytes) || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw invalidOutput('The source prefix was changed.');
  let verified;
  try { verified = verifyPdfIncrementalRevision({ sourceBytes, outputBytes, sourceStructure: state.structure, expectedRevision: transaction.revision }).outputStructure; }
  catch { throw invalidOutput(); }
  let tree;
  const outputTreeStructure = verified.xrefFlavor === 'classic' || verified.xrefFlavor === undefined
    ? parseClassicPdfStructure(outputBytes) : verified;
  try { tree = resolvePdfPageTree({ structure: outputTreeStructure }); } catch { throw invalidOutput(); }
  if (tree.pageCount !== state.tree.pageCount) throw invalidOutput();
  for (let index = 0; index < state.tree.pages.length; index += 1) {
    const before = pageProof(state.tree.pages[index]);
    const after = pageProof(tree.pages[index]);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw invalidOutput('Page geometry or resources changed.');
    for (const stream of state.tree.pages[index].contents) {
      const source = state.contents.get(referenceText(stream.reference));
      const current = tree.pages[index].contents.find((candidate) => sameReference(candidate.reference, stream.reference));
      if (!current) throw invalidOutput();
      const currentBytes = streamBytes(outputBytes, current.stream);
      const expected = sameReference(stream.reference, state.target.reference) ? writtenBytes : source.bytes;
      if (!currentBytes.equals(expected)) throw invalidOutput('An unrelated content stream changed.');
    }
  }
  const targetObject = resolvePdfObject(verified, state.target.reference);
  if (!targetObject.stream || !streamBytes(outputBytes, targetObject).equals(writtenBytes)) throw invalidOutput();
  const outputDigest = sha256(outputBytes);
  return Object.freeze({
    profile: PDF_TEXT_EDIT_PROFILE,
    sourceSha256: sha256(sourceBytes), outputSha256: outputDigest, sourcePrefixPreserved: true,
    page: request.page, streamReference: referenceText(state.target.reference),
    oldTextSha256: sha256(Buffer.from(request.find, 'ascii')),
    newTextSha256: sha256(Buffer.from(request.replace, 'ascii')),
    replacementCount: 1, sourcePageReference: referenceText(state.selected.reference),
    sourcePageObjectNumber: state.selected.reference.object,
    sourcePageGeneration: state.selected.reference.generation,
    sourceGeometry: pageProof(state.selected),
    sourceContentStreams: state.contents.size,
    sourceContentStreamReferences: Object.freeze([...state.contents.keys()]),
    sourceBytes: sourceBytes.length, outputBytes: outputBytes.length,
    revisionCount: verified.revisions.length, appendedBytes: transaction.revision.bytes.length,
    appendedXrefOffset: transaction.revision.xrefOffset,
  });
}

export function writePdfTextEdit(sourceBytes, requestValue = {}) {
  const request = checkedRequest(requestValue);
  const structure = checkedSource(sourceBytes, request.sourceSha256);
  const state = collectState(sourceBytes, structure, request);
  const match = state.target.match;
  const streamOutput = Buffer.from(state.target.bytes);
  streamOutput.set(match.replaceBytes, match.rawStart + 1);
  const originalStream = state.target.stream;
  const transaction = planPdfObjectTransaction({
    sourceBytes, sourceStructure: structure,
    updates: [{ reference: state.target.reference, value: originalStream.value, streamBytes: streamOutput }],
    additions: [], info: { kind: 'preserve' },
    changingId: structure.id ? changedId(sourceBytes, request) : null,
  });
  const outputBytes = Buffer.concat([sourceBytes, transaction.revision.bytes]);
  const proof = outputProof(sourceBytes, outputBytes, state, transaction, streamOutput, request);
  return Object.freeze({ bytes: outputBytes, proof });
}

export function inspectPdfTextEdit(sourceBytes, outputBytes, requestValue = {}) {
  const expected = writePdfTextEdit(sourceBytes, requestValue);
  if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(expected.bytes)) throw invalidOutput();
  return expected.proof;
}

export const writeIncrementalPdfTextEdit = writePdfTextEdit;
export const inspectIncrementalPdfTextEdit = inspectPdfTextEdit;
export const writePdfFindReplace = writePdfTextEdit;
export const inspectPdfFindReplace = inspectPdfTextEdit;
