import { createHash } from 'node:crypto';
import { normalizeClassicPdfObjectValue } from './pdf-classic-object-value.mjs';
import { verifyClosedClassicPdfOutput } from './pdf-classic-closed-output.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolveClassicPdfObject, resolvePdfObject } from './pdf-classic-structure.mjs';

const MAX_OBJECTS = 10_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const descriptors = new WeakSet();
const snapshots = new WeakMap();

function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function invalid() { return fail('INVALID_PDF_COMPACT_REWRITE', 'The PDF compact rewrite request is invalid.'); }
function limited() { return fail('PDF_COMPACT_REWRITE_LIMIT_EXCEEDED', 'The PDF compact rewrite exceeds its fixed safety limits.'); }
function key(reference) { return `${reference.object}:${reference.generation}`; }
function sameReference(left, right) { return left.object === right.object && left.generation === right.generation; }
function cloneReference(reference) { return Object.freeze({ type: 'ref', object: reference.object, generation: reference.generation }); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function checkedBuffer(value, maximumBytes) {
  if (!Buffer.isBuffer(value)) throw invalid();
  if (value.length > maximumBytes) throw limited();
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) throw invalid();
  return value;
}

function pdfVersion(structure) {
  const match = /^%PDF-((?:1\.[0-7]|2\.0))/.exec(structure.buffer.toString('latin1', 0, 10));
  if (!match) throw invalid();
  return match[1];
}

function references(value, output = []) {
  if (value.type === 'ref') output.push(value);
  else if (value.type === 'array') for (const entry of value.values) references(entry, output);
  else if (value.type === 'dict') for (const entry of value.entries.values()) references(entry, output);
  return output;
}

function forbidden(value) {
  if (value.type === 'array') return value.values.some(forbidden);
  if (value.type !== 'dict') return false;
  const type = value.entries.get('Type'); const fieldType = value.entries.get('FT');
  if (value.entries.has('ByteRange') || (type?.type === 'name' && ['XRef', 'ObjStm', 'Sig'].includes(type.value))
    || (fieldType?.type === 'name' && fieldType.value === 'Sig')) return true;
  return [...value.entries.values()].some(forbidden);
}

function directLength(value) {
  const length = value?.type === 'dict' ? value.entries.get('Length') : null;
  if (!length || length.type !== 'number' || !length.integer || length.value < 0) throw invalid();
}

function normalizedRecord(source, object) {
  if (forbidden(object.value)) throw invalid();
  let value = object.value; let streamBytes = null;
  if (object.stream) {
    streamBytes = source.subarray(object.streamStart, object.streamStart + object.streamLength);
    value = { type: 'dict', entries: new Map(value.entries) };
    // The bounded syntax parser may admit an indirect stream Length only when
    // it resolves to one exact effective, non-stream integer object. Emit the
    // canonical direct length so the compact output is consumable by strict
    // classic structure and closed-output validators; the now-unreferenced
    // scalar is intentionally discarded from the reachable graph.
    value.entries.set('Length', { type: 'number', value: streamBytes.length, integer: true, raw: String(streamBytes.length) });
    directLength(value);
  }
  const normalized = normalizeClassicPdfObjectValue(value);
  return Object.freeze({ reference: cloneReference(object.reference), value: normalized.value, body: normalized.body, streamBytes });
}

function collect(source) {
  const structure = parsePdfStructure(source); const seen = new Map();
  const queue = [structure.root, ...(structure.info ? [structure.info] : [])];
  while (queue.length) {
    const reference = queue.pop(); const identity = key(reference);
    if (seen.has(identity)) continue;
    if (seen.size >= MAX_OBJECTS) throw limited();
    let object;
    try { object = resolvePdfObject(structure, reference); } catch { throw invalid(); }
    const record = normalizedRecord(source, object); seen.set(identity, record);
    queue.push(...references(record.value));
  }
  return Object.freeze({ structure, records: Object.freeze([...seen.values()].sort((a, b) => a.reference.object - b.reference.object || a.reference.generation - b.reference.generation)) });
}

function xref(records, offsets) {
  const numbers = records.map((record) => record.reference.object); const byNumber = new Map(records.map((record) => [record.reference.object, record])); const rows = [0, ...numbers];
  let result = 'xref\n'; let index = 0;
  while (index < rows.length) {
    const first = rows[index]; let end = index + 1;
    while (end < rows.length && rows[end] === rows[end - 1] + 1) end += 1;
    result += `${first} ${end - index}\n`;
    for (; index < end; index += 1) {
      if (rows[index] === 0) result += '0000000000 65535 f \n';
      else {
        const record = byNumber.get(rows[index]);
        result += `${String(offsets.get(key(record.reference))).padStart(10, '0')} ${String(record.reference.generation).padStart(5, '0')} n \n`;
      }
    }
  }
  return result;
}

function emit(collected) {
  const version = pdfVersion(collected.structure);
  const chunks = [Buffer.from(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`, 'latin1')]; const offsets = new Map(); let length = chunks[0].length;
  for (const record of collected.records) {
    offsets.set(key(record.reference), length);
    const head = Buffer.from(`${record.reference.object} ${record.reference.generation} obj\n${record.body}\n`, 'latin1');
    const tail = Buffer.from(record.streamBytes ? 'stream\n' : 'endobj\n', 'latin1');
    chunks.push(head, tail); length += head.length + tail.length;
    if (record.streamBytes) { const end = Buffer.from('\nendstream\nendobj\n', 'latin1'); chunks.push(record.streamBytes, end); length += record.streamBytes.length + end.length; }
    if (length > MAX_OUTPUT_BYTES) throw limited();
  }
  const xrefOffset = length; const body = xref(collected.records, offsets); const max = collected.records.at(-1)?.reference.object ?? 0;
  const size = max + 1;
  const info = collected.structure.info ? ` /Info ${collected.structure.info.object} ${collected.structure.info.generation} R` : '';
  const id = collected.structure.id ? ` /ID [<${collected.structure.id[0].toString('hex').toUpperCase()}> <${collected.structure.id[1].toString('hex').toUpperCase()}>]` : '';
  const trailer = Buffer.from(`${body}trailer\n<< /Size ${size} /Root ${collected.structure.root.object} ${collected.structure.root.generation} R${info}${id} >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
  if (length + trailer.length > MAX_OUTPUT_BYTES) throw limited();
  return Buffer.concat([...chunks, trailer]);
}

function proof(source, output, expected) {
  if (!descriptors.has(expected)) throw invalid();
  checkedBuffer(source, MAX_SOURCE_BYTES); checkedBuffer(output, MAX_OUTPUT_BYTES);
  const authority = snapshots.get(expected);
  const sourceSha256 = sha256(source); const outputSha256 = sha256(output);
  if (!authority || source.length !== authority.sourceBytes
    || output.length !== authority.outputBytes
    || sourceSha256 !== authority.sourceSha256
    || outputSha256 !== authority.outputSha256) throw invalid();
  const collected = collect(source);
  const outputStructure = parseClassicPdfStructure(output); const closed = verifyClosedClassicPdfOutput(output);
  const maximumObject = collected.records.at(-1)?.reference.object ?? 0;
  if (pdfVersion(outputStructure) !== pdfVersion(collected.structure)
    || outputStructure.finalSize !== maximumObject + 1
    || !sameReference(outputStructure.root, collected.structure.root)
    || Boolean(outputStructure.info) !== Boolean(collected.structure.info)
    || (outputStructure.info && !sameReference(outputStructure.info, collected.structure.info))
    || Boolean(outputStructure.id) !== Boolean(collected.structure.id)
    || (outputStructure.id && (!outputStructure.id[0].equals(collected.structure.id[0]) || !outputStructure.id[1].equals(collected.structure.id[1])))
    || outputStructure.revisions[0].trailer.has('Prev')) throw invalid();
  for (const record of collected.records) {
    const parsed = resolveClassicPdfObject(outputStructure, record.reference);
    const expectedBody = normalizeClassicPdfObjectValue(record.value).body;
    if (normalizeClassicPdfObjectValue(parsed.value).body !== expectedBody || Boolean(parsed.stream) !== Boolean(record.streamBytes)
      || (record.streamBytes && !output.subarray(parsed.streamStart, parsed.streamStart + parsed.streamLength).equals(record.streamBytes))) throw invalid();
  }
  return Object.freeze({ reachableObjectCount: collected.records.length, outputBytes: output.length, sourceSha256, outputSha256, closed });
}

export function verifyPdfCompactRewrite({ sourceBytes, outputBytes, expectedRewrite } = {}) {
  try { if (!expectedRewrite) throw invalid(); return proof(sourceBytes, outputBytes, expectedRewrite); } catch (error) { if (error?.code === 'PDF_COMPACT_REWRITE_LIMIT_EXCEEDED') throw error; throw invalid(); }
}

export function buildPdfCompactRewrite(sourceBytes) {
  try {
    const source = checkedBuffer(sourceBytes, MAX_SOURCE_BYTES);
    const collected = collect(source); const bytes = emit(collected);
    const sourceSha256 = sha256(source); const outputSha256 = sha256(bytes);
    const descriptor = Object.freeze({ bytes, summary: Object.freeze({ reachableObjectCount: collected.records.length, outputBytes: bytes.length }) });
    descriptors.add(descriptor); snapshots.set(descriptor, Object.freeze({ sourceBytes: source.length, sourceSha256, outputBytes: bytes.length, outputSha256 }));
    proof(source, bytes, descriptor); return descriptor;
  } catch (error) { if (error?.code === 'PDF_COMPACT_REWRITE_LIMIT_EXCEEDED') throw error; throw invalid(); }
}
