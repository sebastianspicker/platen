import { createHash } from 'node:crypto';
import { inspectCmykOutputProfile } from '../icc-profile-provider.mjs';
import { pdfDictionary, pdfInteger, pdfReference, serializePdfValue } from '../pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from '../pdf-classic-structure.mjs';
import { planPdfObjectTransaction, pendingClassicObjectReference } from '../pdf-classic-object-transaction.mjs';
import { verifyPdfIncrementalRevision } from '../pdf-classic-incremental-revision.mjs';
import { buildPdfCompactRewrite, verifyPdfCompactRewrite } from '../pdf-compact-rewrite.mjs';
import { verifyClosedClassicPdfOutput } from '../pdf-classic-closed-output.mjs';
import { visitPdfObjects } from '../pdf-structure-inspection.mjs';
import { inspectPassiveCopyGraph } from '../pdf-copy-page-passive-graph.mjs';
import { OUTPUT_INTENT_LABEL } from './output-intent-contract.mjs';

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_PAGE_TREE_DEPTH = 16;
const MAX_PAGE_TREE_NODES = 256;
const CATALOG_KEYS = new Set(['Type', 'Pages']);
const ACTION_KEYS = new Set(['A', 'AA', 'OpenAction', 'JS', 'Next', 'S']);
const METADATA_KEYS = new Set(['Metadata', 'PieceInfo', 'LastModified', 'ModDate', 'CreationDate']);
const OPTIONAL_KEYS = new Set(['OC', 'OCGs', 'OCProperties']);
const FORM_KEYS = new Set(['AcroForm', 'XFA', 'FT', 'Kids']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function unsupported(message = 'The PDF is outside the bounded OutputIntent assignment subset.') {
  throw failure('UNSUPPORTED_OUTPUT_INTENT_PDF', message);
}
function invalidOutput(message = 'OutputIntent output proof failed.') {
  throw failure('INVALID_OUTPUT_INTENT_OUTPUT', message);
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function key(reference) { return `${reference.object}:${reference.generation}`; }
function sameReference(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }
function ref(value) { try { return pdfReference(value); } catch { unsupported(); } }

function checkedSource(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > MAX_SOURCE_BYTES
    || (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)) unsupported('Source PDF bytes are not a bounded private buffer.');
  return bytes;
}

function valueReferences(value, output = []) {
  if (value?.type === 'ref') output.push(value);
  else if (value?.type === 'array') value.values.forEach((entry) => valueReferences(entry, output));
  else if (value?.type === 'dict') value.entries.forEach((entry) => valueReferences(entry, output));
  return output;
}

function countPageTree(structure, pagesReference) {
  const seen = new Set();
  function visit(reference, parent, depth) {
    if (depth > MAX_PAGE_TREE_DEPTH || seen.size >= MAX_PAGE_TREE_NODES) unsupported('The PDF page tree is malformed or too deep.');
    const identity = key(reference);
    if (seen.has(identity)) unsupported('The PDF page tree contains a cycle or shared node.');
    seen.add(identity);
    const object = resolveClassicPdfObject(structure, reference);
    if (object.stream || object.value?.type !== 'dict') unsupported('The PDF page tree contains a stream or non-dictionary node.');
    const entries = object.value.entries;
    const type = entries.get('Type');
    if (type?.type !== 'name' || !['Page', 'Pages'].includes(type.value)) unsupported('The PDF page tree has an invalid node type.');
    if (parent === null ? entries.has('Parent') : !sameReference(ref(entries.get('Parent')), parent)) unsupported('The PDF page tree parent links are inconsistent.');
    if (type.value === 'Page') {
      if (entries.has('Kids') || !entries.has('MediaBox')) unsupported('The PDF page leaf is malformed.');
      return 1;
    }
    const kids = entries.get('Kids');
    if (kids?.type !== 'array' || kids.values.length < 1) unsupported('The PDF page tree has no children.');
    let count = 0;
    for (const child of kids.values) count += visit(ref(child), reference, depth + 1);
    if (pdfInteger(entries.get('Count')) !== count) unsupported('The PDF page tree count is inconsistent.');
    return count;
  }
  const pages = visit(pagesReference, null, 0);
  if (pages < 1 || pages > MAX_PAGES) unsupported('The PDF page count is outside the bounded assignment subset.');
  return Object.freeze({ pageCount: pages, pageTreeNodeCount: seen.size });
}

function scanPassiveValue(value) {
  if (value?.type === 'array') { value.values.forEach(scanPassiveValue); return; }
  if (value?.type !== 'dict') return;
  const type = value.entries.get('Type');
  const subtype = value.entries.get('Subtype');
  if (value.entries.has('ByteRange') || value.entries.has('Perms')
    || type?.type === 'name' && ['Sig', 'XRef', 'ObjStm', 'Metadata'].includes(type.value)
    || subtype?.type === 'name' && subtype.value === 'Widget') unsupported('Signatures, xref/object streams, and metadata are not supported.');
  for (const name of value.entries.keys()) {
    if (ACTION_KEYS.has(name)) unsupported('Actions and active content are not supported.');
    if (FORM_KEYS.has(name) && name !== 'Kids') unsupported('Forms are not supported.');
    if (METADATA_KEYS.has(name)) unsupported('Metadata surfaces are ambiguous and are not supported.');
    if (OPTIONAL_KEYS.has(name)) unsupported('Optional content is not supported.');
  }
  if (type?.type === 'name' && ['Action', 'Annot', 'Filespec', 'EmbeddedFile'].includes(type.value)) unsupported('Active content or attachments are not supported.');
  value.entries.forEach(scanPassiveValue);
}

function sourceProfile(sourceBytes) {
  const structure = parseClassicPdfStructure(checkedSource(sourceBytes));
  const catalogObject = resolveClassicPdfObject(structure, structure.root);
  if (catalogObject.stream || catalogObject.value?.type !== 'dict') unsupported('The catalog is malformed.');
  const catalog = pdfDictionary(catalogObject.value);
  if (catalog.get('Type')?.type !== 'name' || catalog.get('Type').value !== 'Catalog'
    || [...catalog.keys()].some((name) => !CATALOG_KEYS.has(name))
    || catalog.has('OutputIntents') || catalog.get('Pages')?.type !== 'ref') unsupported('The catalog topology is not the exact passive form required for assignment.');
  if (structure.info) unsupported('An Info dictionary would make metadata provenance ambiguous.');
  const tree = countPageTree(structure, ref(catalog.get('Pages')));
  const graph = inspectPassiveCopyGraph(sourceBytes, { expectedPageCount: tree.pageCount });
  if (graph.revisionCount !== structure.revisions.length || graph.xrefFlavor !== 'classic') unsupported('Only classic uncompressed xref PDFs are supported.');
  const reachable = new Map();
  const pending = [structure.root];
  while (pending.length) {
    const reference = pending.pop(); const identity = key(reference);
    if (reachable.has(identity)) continue;
    const object = resolveClassicPdfObject(structure, reference);
    scanPassiveValue(object.value);
    reachable.set(identity, object);
    pending.push(...valueReferences(object.value));
  }
  const live = [...structure.effective.values()].filter(({ status }) => status === 'n');
  if (live.length !== reachable.size) unsupported('Unreachable or shared catalog objects cannot be proven safe.');
  const rootUseCount = [...reachable.values()].flatMap((object) => valueReferences(object.value))
    .filter((reference) => sameReference(reference, structure.root)).length;
  if (rootUseCount !== 0) unsupported('The catalog is shared by another reachable object.');
  return Object.freeze({ structure, catalogObject, catalog, tree, graph, reachable });
}

function profileInput(value) {
  const bytes = Buffer.isBuffer(value) ? value : value?.bytes;
  const descriptor = Buffer.isBuffer(value) ? null : value?.descriptor;
  if (!Buffer.isBuffer(bytes) || bytes.length < 132 || bytes.length > MAX_PROFILE_BYTES) unsupported('The staged CMYK profile is unavailable.');
  const inspected = inspectCmykOutputProfile(bytes);
  if (inspected.id !== 'ghostscript-default-cmyk' || inspected.sha256 !== sha256(bytes)
    || (descriptor && (descriptor.id !== inspected.id || descriptor.sha256 !== inspected.sha256 || descriptor.size !== inspected.size))) unsupported('The staged profile is not the fixed validated Ghostscript profile.');
  return Object.freeze({ bytes: Buffer.from(bytes), descriptor: inspected });
}

function expectedCatalog(profileReference, intentReference, source) {
  const entries = new Map(source.catalog);
  entries.set('OutputIntents', { type: 'array', values: [intentReference] });
  return Object.freeze({ type: 'dict', entries });
}

function outputProof(sourceBytes, outputBytes, profile, source, transaction, rewrite) {
  const output = parseClassicPdfStructure(outputBytes);
  verifyClosedClassicPdfOutput(outputBytes);
  if (output.revisions.length !== 1 || output.revisions[0].trailer.has('Prev')
    || !sameReference(output.root, source.structure.root) || output.info !== null) invalidOutput('Output is not a closed single-revision copy.');
  const catalog = resolveClassicPdfObject(output, output.root);
  const entries = pdfDictionary(catalog.value); const intents = entries.get('OutputIntents');
  if (intents?.type !== 'array' || intents.values.length !== 1 || intents.values[0]?.type !== 'ref') invalidOutput('OutputIntents does not contain exactly one entry.');
  const intent = resolveClassicPdfObject(output, intents.values[0]);
  if (intent.stream || intent.value?.type !== 'dict') invalidOutput('OutputIntent entry is malformed.');
  const intentEntries = intent.value.entries;
  const required = new Set(['Type', 'S', 'OutputConditionIdentifier', 'Info', 'DestOutputProfile']);
  if (intentEntries.size !== required.size || [...intentEntries.keys()].some((name) => !required.has(name))
    || intentEntries.get('Type')?.value !== 'OutputIntent' || intentEntries.get('S')?.value !== 'GTS_PDFX'
    || intentEntries.get('DestOutputProfile')?.type !== 'ref') invalidOutput('OutputIntent dictionary is not the fixed safe form.');
  for (const name of ['OutputConditionIdentifier', 'Info']) {
    const value = intentEntries.get(name);
    if (value?.type !== 'string' || value.bytes.length < 1 || value.bytes.length > 128
      || value.bytes.toString('latin1') !== OUTPUT_INTENT_LABEL || [...value.bytes].some((byte) => byte < 0x20 || byte > 0x7e)) invalidOutput('OutputIntent label is not the fixed bounded ASCII label.');
  }
  const profileObject = resolveClassicPdfObject(output, intentEntries.get('DestOutputProfile'));
  if (!profileObject.stream || profileObject.value?.type !== 'dict'
    || profileObject.value.entries.get('N')?.type !== 'number' || pdfInteger(profileObject.value.entries.get('N')) !== 4
    || profileObject.value.entries.get('Length')?.value !== profile.bytes.length
    || !outputBytes.subarray(profileObject.streamStart, profileObject.streamStart + profileObject.streamLength).equals(profile.bytes)) invalidOutput('Embedded ICC profile stream is not exact.');
  const sourceIds = [...source.reachable.keys()];
  const outputLiveCount = [...output.effective.values()].filter(({ status }) => status === 'n').length;
  if (outputLiveCount !== sourceIds.length + 2) invalidOutput('Output object delta is not exactly two objects.');
  for (const identity of sourceIds) {
    const original = source.reachable.get(identity); let current;
    try { current = resolveClassicPdfObject(output, { type: 'ref', object: original.reference.object, generation: original.reference.generation }); } catch (error) { invalidOutput(`Source object ${identity} was not retained in the closed output (${error?.code ?? 'unknown'}; root=${output.root?.object}:${output.root?.generation}; live=${[...output.effective.entries()].map(([n, e]) => `${n}:${e.status}`).join(',')}).`); }
    const expected = sameReference(original.reference, source.structure.root)
      ? expectedCatalog(intentEntries.get('DestOutputProfile'), intents.values[0], source)
      : original.value;
    if (serializePdfValue(current.value) !== serializePdfValue(expected)
      || Boolean(current.stream) !== Boolean(original.stream)
      || (original.stream && !outputBytes.subarray(current.streamStart, current.streamStart + current.streamLength).equals(sourceBytes.subarray(original.streamStart, original.streamStart + original.streamLength)))) invalidOutput('A source object changed outside the catalog assignment.');
  }
  return Object.freeze({
    schema: 'pdf-output-intent-assignment-proof-v1', version: 1,
    sourceSha256: sha256(sourceBytes), outputSha256: sha256(outputBytes),
    profileSha256: profile.descriptor.sha256, profileBytes: profile.bytes.length,
    sourceObjectCount: sourceIds.length, outputObjectCount: outputLiveCount,
    objectDelta: 2, xrefDelta: 2, outputIntentCount: 1,
    pageCount: source.tree.pageCount, pageTreeNodeCount: source.tree.pageTreeNodeCount,
    pagesTextBoxesRendersUnchangedExpected: true,
    closedClassicRevision: true, priorRevisionsAbsent: true,
    limitation: 'Assignment records a fixed host-bundled CMYK OutputIntent only; it does not establish PDF/X, colorimetric conformance, press certification, or RIP parity.',
    transaction: Object.freeze({ profileObjectNumber: transaction.referencesById.profile.object, outputIntentObjectNumber: transaction.referencesById.intent.object, appendedXrefOffset: transaction.revision.xrefOffset }),
    compactRewrite: rewrite.summary,
  });
}

export function writePdfOutputIntent(sourceBytes, stagedProfile) {
  try {
    const source = sourceProfile(sourceBytes); const profile = profileInput(stagedProfile);
    const profileId = 'profile'; const intentId = 'intent';
    const profileReference = pendingClassicObjectReference(profileId);
    const intentReference = pendingClassicObjectReference(intentId);
    const catalogValue = expectedCatalog(profileReference, intentReference, source);
    const transaction = planPdfObjectTransaction({
      sourceBytes, sourceStructure: source.structure,
      updates: [{ reference: source.structure.root, value: catalogValue }],
      additions: [
        { id: profileId, value: { type: 'dict', entries: new Map([['N', { type: 'number', value: 4, integer: true, raw: '4' }]]) }, streamBytes: profile.bytes },
        { id: intentId, value: { type: 'dict', entries: new Map([
          ['Type', { type: 'name', value: 'OutputIntent' }], ['S', { type: 'name', value: 'GTS_PDFX' }],
          ['OutputConditionIdentifier', { type: 'string', format: 'hex', bytes: Buffer.from(OUTPUT_INTENT_LABEL, 'ascii') }],
          ['Info', { type: 'string', format: 'hex', bytes: Buffer.from(OUTPUT_INTENT_LABEL, 'ascii') }],
          ['DestOutputProfile', profileReference],
        ]) } },
      ],
      info: { kind: 'preserve' }, changingId: null,
    });
    const appended = Buffer.concat([sourceBytes, transaction.revision.bytes]);
    verifyPdfIncrementalRevision({ sourceBytes, outputBytes: appended, sourceStructure: source.structure, expectedRevision: transaction.revision });
    const rewrite = buildPdfCompactRewrite(appended);
    verifyPdfCompactRewrite({ sourceBytes: appended, outputBytes: rewrite.bytes, expectedRewrite: rewrite });
    const proof = outputProof(sourceBytes, rewrite.bytes, profile, source, transaction, rewrite);
    const descriptor = Object.freeze({ bytes: rewrite.bytes, proof });
    return descriptor;
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_OUTPUT_INTENT_PDF' || error?.code === 'INVALID_OUTPUT_INTENT_OUTPUT') throw error;
    throw Object.assign(failure('UNSUPPORTED_OUTPUT_INTENT_PDF', 'The PDF is outside the bounded OutputIntent assignment subset.'), { cause: error });
  }
}

export const writeOutputIntentPdf = writePdfOutputIntent;
export const inspectPdfOutputIntent = ({ sourceBytes, outputBytes, stagedProfile } = {}) => {
  const written = writePdfOutputIntent(sourceBytes, stagedProfile);
  if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(written.bytes)) invalidOutput('Output differs from the source-bound writer result.');
  return written.proof;
};
