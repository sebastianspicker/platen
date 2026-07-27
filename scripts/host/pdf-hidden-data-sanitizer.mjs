import { createHash } from 'node:crypto';
import { normalizeClassicPdfObjectValue } from './pdf-classic-object-value.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolvePdfObject } from './pdf-classic-structure.mjs';
import { pdfDictionary } from './pdf-classic-syntax.mjs';
import { inspectPdfHiddenDataInventory } from './pdf-hidden-data-inventory.mjs';

export const PDF_HIDDEN_DATA_SANITIZER_PROFILE = 'local-pdf-hidden-data-sanitizer-v1';
export const MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_PDF_HIDDEN_DATA_SANITIZER_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_OBJECTS = 10_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const REMOVED_KEYS = new Set([
  'AcroForm', 'AF', 'AlternatePresentations', 'JavaScript', 'MarkInfo', 'Metadata',
  'OCProperties', 'OpenAction', 'Perms', 'PieceInfo', 'Private', 'RichMediaContent',
  'SpiderInfo', 'StructTreeRoot', 'XFA',
]);
const COUNTS = Object.freeze(['xmpMetadata', 'embeddedFiles', 'javascriptActions', 'actionObjects', 'acroForm', 'xfa', 'optionalContent', 'structTree', 'marked', 'hiddenAnnotations', 'pageThumbnails', 'pieceInfo', 'spiderInfo', 'privateData', 'alternateImages', 'opi']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function invalid(message = 'The bounded hidden-data sanitizer request is invalid.') { throw failure('INVALID_PDF_HIDDEN_DATA_SANITIZER', message); }
function unsupported(message = 'The PDF is outside the bounded hidden-data sanitizer subset.') { throw failure('UNSUPPORTED_PDF_HIDDEN_DATA_SANITIZER_SOURCE', message); }
function outputInvalid(message = 'The hidden-data sanitizer output failed independent verification.') { throw failure('INVALID_PDF_HIDDEN_DATA_SANITIZER_OUTPUT', message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function key(reference) { return `${reference.object}:${reference.generation}`; }
function ref(value) { return Object.freeze({ type: 'ref', object: value.object, generation: value.generation }); }

function checkedSource(source, sourceSha256) {
  if (!Buffer.isBuffer(source) || source.length < 5 || source.length > MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES
    || (typeof SharedArrayBuffer !== 'undefined' && source.buffer instanceof SharedArrayBuffer)) invalid('sourceBytes is outside the bounded private-buffer contract.');
  const actual = digest(source);
  if (sourceSha256 !== undefined && (!SHA256.test(sourceSha256) || sourceSha256 !== actual)) invalid('sourceSha256 does not match sourceBytes.');
  let structure;
  try { structure = parsePdfStructure(source); } catch { unsupported('The source PDF structure is malformed.'); }
  if (structure.revisions.length !== 1 || structure.xrefFlavor !== 'classic' || structure.revisions[0].trailer.has('Encrypt')) unsupported('Encrypted, incremental, or non-classic-xref PDFs are rejected.');
  if ([...structure.effective.values()].some((entry) => entry.status === 'c')) unsupported('Compressed object graphs are rejected.');
  if ([...structure.effective.values()].some((entry) => entry.status === 'n' && entry.generation !== 0)) unsupported('Nonzero-generation objects are rejected by the bounded rewrite.');
  return Object.freeze({ source, sourceSha256: actual, structure });
}

function references(value, result = []) {
  if (value?.type === 'ref') result.push(value);
  else if (value?.type === 'array') value.values.forEach((entry) => references(entry, result));
  else if (value?.type === 'dict') value.entries.forEach((entry) => references(entry, result));
  return result;
}

function transform(value, context, removed, resolve) {
  if (value?.type === 'array') return Object.freeze({ type: 'array', values: Object.freeze(value.values.map((entry) => transform(entry, context, removed, resolve))) });
  if (value?.type !== 'dict') return value;
  const entries = new Map();
  const type = value.entries.get('Type'); const role = type?.type === 'name' ? type.value : context;
  for (const [name, child] of value.entries) {
    const catalogHidden = role === 'Catalog' && REMOVED_KEYS.has(name);
    const pageHidden = role === 'Page' && (['Annots', 'AA', 'A', 'Thumb', 'Metadata'].includes(name) || REMOVED_KEYS.has(name));
    const imageHidden = role === 'XObject' && type?.type === 'name' && type.value === 'XObject' && ['Alternates', 'OPI'].includes(name);
    if (catalogHidden || pageHidden || imageHidden) {
      removed.add(name);
      continue;
    }
    if (role === 'Catalog' && name === 'Names') {
      const nameValue = child?.type === 'dict' ? child : child?.type === 'ref' ? resolve(child)?.value : null;
      if (nameValue?.type !== 'dict') unsupported('The catalog name tree is not directly inspectable.');
      const names = [...nameValue.entries.keys()];
      if (names.some((entry) => !['EmbeddedFiles', 'JavaScript'].includes(entry))) unsupported('Mixed name trees are ambiguous and cannot be sanitized safely.');
      if (names.length > 0) { removed.add(names[0]); continue; }
    }
    entries.set(name, transform(child, null, removed, resolve));
  }
  return Object.freeze({ type: 'dict', entries });
}

function normalizedRecords(profile) {
  const records = new Map(); const queue = [profile.structure.root]; const seen = new Set();
  while (queue.length) {
    const reference = queue.pop(); const identity = key(reference);
    if (seen.has(identity)) continue;
    if (seen.size >= MAX_OBJECTS) unsupported('The reachable PDF graph exceeds the bounded object limit.');
    const entry = profile.structure.effective.get(reference.object);
    if (!entry || entry.status !== 'n' || entry.generation !== reference.generation) unsupported('The reachable PDF graph contains a missing or aliased reference.');
    let object; try { object = resolvePdfObject(profile.structure, reference); } catch { unsupported('The reachable PDF graph is malformed.'); }
    if (object.compressed || object.value?.type === 'null') unsupported('Compressed or unsupported reachable objects are rejected.');
    const removed = new Set();
    let value = transform(object.value, object.value?.type === 'dict' ? object.value.entries.get('Type')?.value : null, removed, (reference) => resolvePdfObject(profile.structure, reference));
    let streamBytes = null;
    if (object.stream) {
      if (object.streamLength < 0 || object.streamStart < 0 || object.streamStart + object.streamLength > profile.source.length) unsupported('A stream lies outside the source bytes.');
      streamBytes = profile.source.subarray(object.streamStart, object.streamStart + object.streamLength);
      if (value?.type !== 'dict') unsupported('Stream objects must have dictionaries.');
      const streamEntries = new Map(value.entries); streamEntries.set('Length', { type: 'number', value: streamBytes.length, integer: true, raw: String(streamBytes.length) }); value = Object.freeze({ type: 'dict', entries: streamEntries });
    }
    let normalized; try { normalized = normalizeClassicPdfObjectValue(value); } catch { unsupported('An object cannot be safely serialized.'); }
    const record = Object.freeze({ reference: ref(reference), value: normalized.value, body: normalized.body, streamBytes });
    records.set(identity, record); seen.add(identity);
    queue.push(...references(record.value));
  }
  return [...records.values()].sort((left, right) => left.reference.object - right.reference.object || left.reference.generation - right.reference.generation);
}

function emit(profile, records) {
  const version = /^%PDF-((?:1\.[0-7]|2\.0))/u.exec(profile.source.toString('latin1', 0, 10))?.[1];
  if (!version) unsupported('The source PDF version is unsupported.');
  const chunks = [Buffer.from(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`, 'latin1')]; const offsets = new Map(); let length = chunks[0].length;
  for (const record of records) {
    offsets.set(key(record.reference), length);
    const head = Buffer.from(`${record.reference.object} ${record.reference.generation} obj\n${record.body}\n`, 'latin1'); chunks.push(head); length += head.length;
    if (record.streamBytes) { const start = Buffer.from('stream\n', 'latin1'); const end = Buffer.from('\nendstream\nendobj\n', 'latin1'); chunks.push(start, record.streamBytes, end); length += start.length + record.streamBytes.length + end.length; }
    else { const end = Buffer.from('endobj\n', 'latin1'); chunks.push(end); length += end.length; }
    if (length > MAX_PDF_HIDDEN_DATA_SANITIZER_OUTPUT_BYTES) throw failure('PDF_HIDDEN_DATA_SANITIZER_LIMIT_EXCEEDED', 'The sanitized output exceeds its bounded size.');
  }
  const numbers = records.map((record) => record.reference.object); const byNumber = new Map(records.map((record) => [record.reference.object, record])); const rows = [0, ...numbers]; let xref = 'xref\n'; let index = 0;
  while (index < rows.length) { const first = rows[index]; let end = index + 1; while (end < rows.length && rows[end] === rows[end - 1] + 1) end += 1; xref += `${first} ${end - index}\n`; for (; index < end; index += 1) { const number = rows[index]; xref += number === 0 ? '0000000000 65535 f \n' : `${String(offsets.get(key(byNumber.get(number).reference))).padStart(10, '0')} 00000 n \n`; } }
  const xrefOffset = length; const max = records.at(-1)?.reference.object ?? 0; const trailer = Buffer.from(`${xref}trailer\n<< /Size ${max + 1} /Root ${profile.structure.root.object} ${profile.structure.root.generation} R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
  return Buffer.concat([...chunks, trailer]);
}

function pageContentDigest(bytes) {
  let structure; try { structure = parsePdfStructure(bytes); } catch { outputInvalid('Page-content postflight parsing failed.'); }
  const contents = [];
  const resolve = (reference) => resolvePdfObject(structure, reference);
  const walk = (reference) => {
    const object = resolve(reference); const dictionary = object.value?.type === 'dict' ? pdfDictionary(object.value) : null;
    if (!dictionary) return;
    if (dictionary.get('Type')?.type === 'name' && dictionary.get('Type').value === 'Page') {
      const value = dictionary.get('Contents'); const refs = value?.type === 'ref' ? [value] : value?.type === 'array' ? value.values.filter((entry) => entry?.type === 'ref') : [];
      for (const content of refs) { const stream = resolve(content); if (!stream.stream) outputInvalid('Page content is not a stream.'); contents.push(digest(bytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength))); }
      return;
    }
    const kids = dictionary.get('Kids'); if (kids?.type === 'array') for (const child of kids.values) if (child?.type === 'ref') walk(child);
  };
  walk(structure.root); return digest(Buffer.from(contents.join('|'), 'ascii'));
}

function assertNoResidue(output, sourceSha256) {
  let inventory; try { inventory = inspectPdfHiddenDataInventory(output, { sourceSha256: digest(output) }); } catch { outputInvalid('The sanitized output is not independently inventory-readable.'); }
  if (inventory.revisionCount !== 1 || inventory.orphanResidue.present || inventory.priorRevisionResidue.present || inventory.signatureFields || inventory.byteRanges) outputInvalid('The sanitized output retains revision, orphan, or signature residue.');
  if (COUNTS.some((name) => inventory[name] !== 0)) outputInvalid(`The sanitized output retains a bounded hidden-data class: ${COUNTS.filter((name) => inventory[name] !== 0).join(',')}.`);
  return inventory;
}

function build(sourceBytes, options = {}) {
  const sourceSha256 = options?.sourceSha256; const profile = checkedSource(sourceBytes, sourceSha256); const before = inspectPdfHiddenDataInventory(profile.source, { sourceSha256: profile.sourceSha256 });
  if (before.signatureFields || before.byteRanges) unsupported('Signed or signature-field sources are rejected.');
  const records = normalizedRecords(profile); const output = emit(profile, records); const after = assertNoResidue(output, profile.sourceSha256);
  if (pageContentDigest(profile.source) !== pageContentDigest(output)) outputInvalid('Reachable page content streams changed during sanitization.');
  const removed = Object.freeze(Object.fromEntries(COUNTS.map((name) => [name, Math.max(0, before[name] - after[name])] ).filter(([, value]) => value > 0)));
  const pageContentSha256 = pageContentDigest(profile.source);
  const proof = Object.freeze({ profile: PDF_HIDDEN_DATA_SANITIZER_PROFILE, sourceSha256: profile.sourceSha256, outputSha256: digest(output), sourceBytes: profile.source.length, outputBytes: output.length, removed, pageContentSha256, sourcePrefixPreserved: false, closedClassicRevision: true, reachablePageContentPreserved: true, orphanResidueAbsent: true, priorRevisionResidueAbsent: true, limitations: Object.freeze(['This removes only document metadata, file attachments/file specifications, JavaScript/actions, forms, optional-content/structure metadata, and page annotations from classic single-revision PDFs.', 'It rejects mixed name trees, encrypted or incremental sources, compressed or nonzero-generation objects, signatures, and ambiguous graphs rather than attempting broad cleanup.', 'It does not establish visual, semantic, accessibility, legal, or signature-preservation equivalence.']) });
  return Object.freeze({ bytes: output, proof });
}

export function buildPdfHiddenDataSanitization(sourceBytes, options = {}) { try { return build(sourceBytes, options); } catch (error) { if (error?.code === 'PDF_HIDDEN_DATA_SANITIZER_LIMIT_EXCEEDED') throw error; throw error?.code ? error : failure('INVALID_PDF_HIDDEN_DATA_SANITIZER', 'The hidden-data sanitizer request is invalid.'); } }
export const sanitizePdfHiddenData = buildPdfHiddenDataSanitization;
export const buildPdfHiddenDataSanitizer = buildPdfHiddenDataSanitization;

export function inspectPdfHiddenDataSanitization(sourceBytes, outputBytes, options = {}) {
  const expected = buildPdfHiddenDataSanitization(sourceBytes, options);
  if (!Buffer.isBuffer(outputBytes) || !outputBytes.equals(expected.bytes)) outputInvalid();
  return expected.proof;
}

export function verifyPdfHiddenDataSanitization({ sourceBytes, outputBytes, options = {}, expected } = {}) {
  if (!expected || typeof expected !== 'object') invalid('Expected sanitizer proof is required.');
  const proof = inspectPdfHiddenDataSanitization(sourceBytes, outputBytes, options);
  if (proof.outputSha256 !== expected.outputSha256 || proof.sourceSha256 !== expected.sourceSha256) outputInvalid('The sanitizer proof does not match the output.');
  return proof;
}
