const MAX_ITEMS = 20_000;
const MAX_TOTAL_AST_ITEMS = 100_000;
const MAX_TOTAL_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_NAME_BYTES = 256;
const MAX_STRING_BYTES = 64 * 1024;
export const MAX_STREAM_BYTES = 256 * 1024 * 1024;
const MAX_XREF_ENTRIES = 50_000;
const TAIL_BYTES = 64 * 1024;
const LITERAL_ESCAPES = new Map([[0x6e, 10], [0x72, 13], [0x74, 9], [0x62, 8], [0x66, 12]]);
const SINGLE_TOKENS = new Map([[0x5b, 'arrayStart'], [0x5d, 'arrayEnd']]);
function invalid() { const error = new Error('PDF classic syntax is malformed or unsupported.'); error.code = 'INVALID_CLASSIC_PDF_SYNTAX'; return error; }
function whitespace(byte) { return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32; }
function delimiter(byte) { return whitespace(byte) || [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25].includes(byte); }
function nibble(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}
function octal(byte) { return byte >= 0x30 && byte <= 0x37; }
function literalEscape(buffer, position, limit) {
  if (position >= limit) throw invalid();
  const byte = buffer[position++];
  const escaped = LITERAL_ESCAPES.get(byte);
  if (escaped !== undefined) return { position, byte: escaped };
  return unescapedLiteralByte(buffer, position, byte);
}
function unescapedLiteralByte(buffer, position, byte) { const continuation = literalContinuation(buffer, position, byte); if (continuation) return continuation; return octal(byte) ? octalLiteralByte(buffer, position, byte) : { position, byte }; }
function literalContinuation(buffer, position, byte) {
  if (byte === 10) return { position, byte: null };
  if (byte !== 13) return null;
  if (buffer[position] === 10) position += 1;
  return { position, byte: null };
}
function octalLiteralByte(buffer, position, byte) {
  let value = byte - 0x30;
  for (let count = 1; count < 3 && octal(buffer[position]); count += 1) value = (value * 8) + buffer[position++] - 0x30;
  if (value > 255) throw invalid();
  return { position, byte: value };
}
function literalLineEnding(buffer, position, byte) { if (byte === 13 && buffer[position] === 10) position += 1; return { position, byte: byte === 13 ? 10 : byte }; }
function hexDigits(buffer, position, limit) {
  const digits = [];
  while (position < limit && buffer[position] !== 0x3e) {
    const byte = buffer[position++];
    if (whitespace(byte)) continue;
    const value = nibble(byte);
    if (value < 0 || digits.length >= MAX_STRING_BYTES * 2) throw invalid();
    digits.push(value);
  }
  if (buffer[position] !== 0x3e) throw invalid();
  return { digits, position: position + 1 };
}
function hexBytes(digits) { const bytes = Buffer.alloc(Math.ceil(digits.length / 2)); for (let index = 0; index < digits.length; index += 2) bytes[index / 2] = (digits[index] << 4) | (digits[index + 1] ?? 0); return bytes; }
function nameBytes(buffer, position, limit) {
  const bytes = [];
  while (position < limit && !delimiter(buffer[position])) {
    const byte = buffer[position++];
    if (byte === 0x23) {
      const high = nibble(buffer[position]);
      const low = nibble(buffer[position + 1]);
      if (high < 0 || low < 0) throw invalid();
      bytes.push((high << 4) | low);
      position += 2;
    } else bytes.push(byte);
    if (bytes.length > MAX_NAME_BYTES) throw invalid();
  }
  return { bytes, position };
}
function structuralToken(buffer, position) {
  const byte = buffer[position];
  const next = buffer[position + 1];
  if (byte === 0x3c && next === 0x3c) return { type: 'dictStart', end: position + 2 };
  if (byte === 0x3e && next === 0x3e) return { type: 'dictEnd', end: position + 2 };
  const type = SINGLE_TOKENS.get(byte);
  return type ? { type, end: position + 1 } : null;
}
function wordEnd(buffer, position, limit) { while (position < limit && !delimiter(buffer[position])) position += 1; return position; }
function rawToken(buffer, start, end) { const raw = buffer.subarray(start, end).toString('latin1'); if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) { const value = Number(raw); if (!Number.isFinite(value)) throw invalid(); return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw, start, end }); } return Object.freeze({ type: 'word', value: raw, start, end }); }
function literalFragment({ buffer, position, limit, byte, depth }) {
  if (byte === 0x5c) { const escaped = literalEscape(buffer, position, limit); return { position: escaped.position, byte: escaped.byte, depth }; }
  if (byte === 0x28) return { position, byte, depth: depth + 1 };
  if (byte === 0x29) return { position, byte: depth === 1 ? null : byte, depth: depth - 1 };
  const normalized = literalLineEnding(buffer, position, byte);
  return { position: normalized.position, byte: normalized.byte, depth };
}
class Lexer {
  #buffer; #position; #limit; #lookahead = [];
  constructor(buffer, position = 0, limit = buffer.length) {
    this.#buffer = buffer; this.#position = position; this.#limit = limit;
  }
  #skipTrivia() {
    while (this.#position < this.#limit) {
      if (whitespace(this.#buffer[this.#position])) { this.#position += 1; continue; }
      if (this.#buffer[this.#position] !== 0x25) return;
      while (this.#position < this.#limit
        && this.#buffer[this.#position] !== 10 && this.#buffer[this.#position] !== 13) this.#position += 1;
    }
  }
  #literal(start) {
    const bytes = [];
    let depth = 1;
    this.#position += 1;
    while (this.#position < this.#limit && depth > 0) {
      const byte = this.#buffer[this.#position++];
      const parsed = literalFragment({ buffer: this.#buffer, position: this.#position, limit: this.#limit, byte, depth });
      this.#position = parsed.position;
      depth = parsed.depth;
      if (parsed.byte !== null) bytes.push(parsed.byte);
      if (depth > MAX_DEPTH || bytes.length > MAX_STRING_BYTES) throw invalid();
    }
    if (depth !== 0) throw invalid();
    return Object.freeze({ type: 'string', format: 'literal', bytes: Buffer.from(bytes), start, end: this.#position });
  }
  #hex(start) {
    const parsed = hexDigits(this.#buffer, this.#position + 1, this.#limit);
    this.#position = parsed.position;
    return Object.freeze({ type: 'string', format: 'hex', bytes: hexBytes(parsed.digits), start, end: this.#position });
  }
  #name(start) {
    const parsed = nameBytes(this.#buffer, this.#position + 1, this.#limit);
    this.#position = parsed.position;
    return Object.freeze({ type: 'name', value: Buffer.from(parsed.bytes).toString('latin1'), start, end: this.#position });
  }
  #raw() {
    this.#skipTrivia();
    const start = this.#position;
    if (start >= this.#limit) return Object.freeze({ type: 'eof', start, end: start });
    const structural = structuralToken(this.#buffer, start);
    if (structural) {
      this.#position = structural.end;
      return { type: structural.type, start, end: this.#position };
    }
    const byte = this.#buffer[start];
    if (byte === 0x28) return this.#literal(start);
    if (byte === 0x3c) return this.#hex(start);
    if (byte === 0x2f) return this.#name(start);
    this.#position = wordEnd(this.#buffer, this.#position, this.#limit);
    if (start === this.#position) throw invalid();
    return rawToken(this.#buffer, start, this.#position);
  }
  peek(index = 0) { while (this.#lookahead.length <= index) this.#lookahead.push(this.#raw()); return this.#lookahead[index]; }
  next() { return this.#lookahead.length ? this.#lookahead.shift() : this.#raw(); }
}
function integerRaw(raw) { return /^[+-]?\d+$/.test(raw); }
function syntaxBudget(sharedBudget) { const budget = sharedBudget ?? { items: 0, decodedBytes: 0 }; if (!Number.isSafeInteger(budget.items) || budget.items < 0) throw invalid(); if (!Number.isSafeInteger(budget.decodedBytes) || budget.decodedBytes < 0) throw invalid(); return budget; }
function reserveValue(state, depth) { state.items += 1; state.budget.items += 1; if (state.items > MAX_ITEMS || state.budget.items > MAX_TOTAL_AST_ITEMS || depth > MAX_DEPTH) throw invalid(); }
function decodedBytes(state, count) { state.budget.decodedBytes += count; if (state.budget.decodedBytes > MAX_TOTAL_DECODED_BYTES) throw invalid(); }
function parseNumber(token, lexer) {
  if (!referenceLead(token)) return numericValue(token);
  const generation = referenceGeneration(lexer);
  if (!generation) return numericValue(token);
  lexer.next(); lexer.next();
  if (token.value < 1 || generation.value < 0 || generation.value > 65_535) throw invalid();
  return Object.freeze({ type: 'ref', object: token.value, generation: generation.value });
}
function numericValue(token) { return Object.freeze({ type: 'number', value: token.value, integer: token.integer, raw: token.raw }); }
function referenceLead(token) { return token.integer && integerRaw(token.raw); }
function referenceGeneration(lexer) {
  const generation = lexer.peek();
  if (generation.type !== 'number' || !referenceLead(generation)) return null;
  const marker = lexer.peek(1);
  return marker.type === 'word' && marker.value === 'R' ? generation : null;
}
function parseWord(token) {
  if (token.value === 'true' || token.value === 'false') return Object.freeze({ type: 'boolean', value: token.value === 'true' });
  if (token.value === 'null') return Object.freeze({ type: 'null' });
  throw invalid();
}
function parseString(token, state) { decodedBytes(state, token.bytes.length); return Object.freeze({ type: 'string', format: token.format, bytes: token.bytes }); }
function parseName(token, state) { decodedBytes(state, Buffer.byteLength(token.value, 'latin1')); return Object.freeze({ type: 'name', value: token.value }); }
function parseArray(lexer, state, depth) {
  const values = [];
  while (true) {
    const token = lexer.peek();
    if (token.type === 'arrayEnd') break;
    if (token.type === 'eof') throw invalid();
    values.push(parseValue(lexer, state, depth + 1));
  }
  lexer.next();
  return Object.freeze({ type: 'array', values: Object.freeze(values) });
}
function parseDictionary(lexer, state, depth) {
  const entries = new Map();
  while (lexer.peek().type !== 'dictEnd') {
    const key = lexer.next();
    if (key.type !== 'name' || entries.has(key.value)) throw invalid();
    decodedBytes(state, Buffer.byteLength(key.value, 'latin1'));
    entries.set(key.value, parseValue(lexer, state, depth + 1));
  }
  lexer.next();
  return Object.freeze({ type: 'dict', entries });
}
function parseValue(lexer, state, depth = 0) {
  reserveValue(state, depth);
  const token = lexer.next();
  if (token.type === 'number') return parseNumber(token, lexer);
  if (token.type === 'word') return parseWord(token);
  if (token.type === 'string') return parseString(token, state);
  if (token.type === 'name') return parseName(token, state);
  if (token.type === 'arrayStart') return parseArray(lexer, state, depth);
  if (token.type === 'dictStart') return parseDictionary(lexer, state, depth);
  throw invalid();
}
function exactWord(token, value) { if (token.type !== 'word' || token.value !== value) throw invalid(); }
function unsigned(token) {
  if (token.type !== 'number') throw invalid();
  if (!token.integer || token.value < 0 || !/^\d+$/.test(token.raw)) throw invalid();
  return token.value;
}
function skipWhitespace(buffer, position) { while (position < buffer.length && whitespace(buffer[position])) position += 1; return position; }
function asciiAt(buffer, position, value) { return buffer.subarray(position, position + value.length).toString('latin1') === value; }
function lineStart(buffer, position) { return position === 0 || buffer[position - 1] === 10 || buffer[position - 1] === 13; }
function validValueSlice(buffer, start, end) { if (!Buffer.isBuffer(buffer)) return false; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false; return start >= 0 && end >= start && end <= buffer.length; }
export function parsePdfValueSlice(buffer, start = 0, end = buffer?.length, sharedBudget = null) {
  if (!validValueSlice(buffer, start, end)) throw invalid();
  const lexer = new Lexer(buffer, start, end);
  const value = parseValue(lexer, { items: 0, budget: syntaxBudget(sharedBudget) });
  const tail = lexer.next();
  if (tail.type !== 'eof') throw invalid();
  return value;
}
function validStartXrefBuffer(buffer) { return Buffer.isBuffer(buffer) && buffer.length >= 32; }
export function findFinalStartXref(buffer) {
  if (!validStartXrefBuffer(buffer)) throw invalid();
  const start = Math.max(0, buffer.length - TAIL_BYTES);
  const match = /startxref[\x00\x09\x0a\x0c\x0d\x20]+([0-9]+)[\x00\x09\x0a\x0c\x0d\x20]+%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.exec(buffer.subarray(start).toString('latin1'));
  const markerOffset = match ? start + match.index : -1;
  const offset = Number(match?.[1]);
  if (!lineStart(buffer, markerOffset)) throw invalid();
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= buffer.length) throw invalid();
  return offset;
}
function validClassicOffset(buffer, offset) { if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset)) return false; return offset >= 0 && offset < buffer.length && lineStart(buffer, offset); }
function xrefSubsection(firstToken, lexer, context) {
  const first = unsigned(firstToken);
  const count = unsigned(lexer.next());
  if (count < 1 || first + count > MAX_XREF_ENTRIES || context.entries.length + count > MAX_XREF_ENTRIES) throw invalid();
  for (let index = 0; index < count; index += 1) xrefRow(lexer, first + index, context);
}
function xrefRow(lexer, object, context) {
  const tokens = { offset: lexer.next(), generation: lexer.next(), status: lexer.next() };
  validateXrefTokens(tokens);
  if (context.objects.has(object)) throw invalid();
  context.objects.add(object);
  const entry = xrefEntry(tokens, object, context.offset);
  context.entries.push(entry);
}
function validateXrefTokens(tokens) {
  const { offset: offsetToken, generation: generationToken, status } = tokens;
  if (!/^\d{10}$/.test(offsetToken.raw ?? '') || !/^\d{5}$/.test(generationToken.raw ?? '')) throw invalid();
  if (status.type !== 'word' || !['n', 'f'].includes(status.value)) throw invalid();
}
function xrefEntry(tokens, object, sectionOffset) {
  const { offset: offsetToken, generation: generationToken, status } = tokens;
  const objectOffset = unsigned(offsetToken); const generation = unsigned(generationToken);
  if (generation > 65_535) throw invalid();
  if (status.value === 'n' && (object === 0 || objectOffset >= sectionOffset)) throw invalid();
  if (object === 0 && (status.value !== 'f' || generation !== 65_535)) throw invalid();
  return Object.freeze({ object, generation, offset: objectOffset, status: status.value });
}
function xrefEntries(lexer, offset) {
  const context = { entries: [], objects: new Set(), offset };
  while (true) {
    const firstToken = lexer.next();
    if (firstToken.type === 'word' && firstToken.value === 'trailer') return context.entries;
    xrefSubsection(firstToken, lexer, context);
  }
}
function xrefTail(buffer, lexer, offset, sharedBudget) {
  const trailer = parseValue(lexer, { items: 0, budget: syntaxBudget(sharedBudget) });
  if (trailer.type !== 'dict') throw invalid();
  const startxref = lexer.next();
  if (!lineStart(buffer, startxref.start)) throw invalid();
  exactWord(startxref, 'startxref');
  const pointer = lexer.next();
  if (unsigned(pointer) !== offset) throw invalid();
  let eof = skipWhitespace(buffer, pointer.end);
  if (!asciiAt(buffer, eof, '%%EOF')) throw invalid();
  eof = skipWhitespace(buffer, eof + 5);
  return { trailer: trailer.entries, revisionEnd: eof };
}
export function parseClassicXrefSection(buffer, offset, sharedBudget = null) {
  if (!validClassicOffset(buffer, offset)) throw invalid();
  const lexer = new Lexer(buffer, offset);
  const marker = lexer.next();
  if (marker.start !== offset) throw invalid();
  exactWord(marker, 'xref');
  const entries = xrefEntries(lexer, offset);
  const tail = xrefTail(buffer, lexer, offset, sharedBudget);
  return Object.freeze({ offset, entries: Object.freeze(entries), trailer: tail.trailer, revisionEnd: tail.revisionEnd });
}
function indirectHeaderMatches(header) {
  if (header.object.start !== header.offset) throw invalid();
  if (unsigned(header.object) !== header.reference.object) throw invalid();
  if (unsigned(header.generation) !== header.reference.generation) throw invalid();
  exactWord(header.marker, 'obj');
}
function objectEndToken(token) { return token.type === 'word' && (token.value === 'stream' || token.value === 'endobj'); }
export function parseIndirectObjectHeader(buffer, offset, reference, sharedBudget = null) {
  if (!validClassicOffset(buffer, offset)) throw invalid();
  const budget = syntaxBudget(sharedBudget);
  const lexer = new Lexer(buffer, offset);
  const object = lexer.next(); const generation = lexer.next(); const marker = lexer.next();
  indirectHeaderMatches({ object, generation, marker, offset, reference });
  const value = parseValue(lexer, { items: 0, budget });
  const streamToken = lexer.next();
  if (!objectEndToken(streamToken)) throw invalid();
  return Object.freeze({
    reference: Object.freeze({ ...reference }), value, stream: streamToken.value === 'stream', streamToken,
  });
}
function resolvedStreamLength(value, resolveLength) { const lengthValue = value.entries.get('Length'); const length = lengthValue?.type === 'ref' ? resolveLength?.(lengthValue) : pdfInteger(lengthValue); if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STREAM_BYTES) throw invalid(); return length; }
function streamPayloadStart(buffer, token) {
  let start = token.end;
  if (buffer[start] === 13 && buffer[start + 1] === 10) return start + 2;
  if (buffer[start] === 10) return start + 1;
  throw invalid();
}
function streamEnd(buffer, start, length) {
  let position = start + length;
  if (!asciiAt(buffer, position, 'endstream')) {
    if (buffer[position] === 13 && buffer[position + 1] === 10) position += 2;
    else if (buffer[position] === 10 || buffer[position] === 13) position += 1;
  }
  if (!asciiAt(buffer, position, 'endstream') || !delimiter(buffer[position + 9])) throw invalid();
  return position;
}
function endObject(buffer, position) { const token = new Lexer(buffer, position).next(); exactWord(token, 'endobj'); return token; }
function parseStream(buffer, header, resolveLength) {
  if (header.value.type !== 'dict') throw invalid();
  const length = resolvedStreamLength(header.value, resolveLength);
  const start = streamPayloadStart(buffer, header.streamToken);
  if (length > buffer.length - start) throw invalid();
  const endstream = streamEnd(buffer, start, length);
  return { start, length, end: endObject(buffer, endstream + 9).end };
}
export function parsePdfIndirectObject(buffer, offset, reference, sharedBudget = null, { resolveLength } = {}) {
  const header = parseIndirectObjectHeader(buffer, offset, reference, sharedBudget);
  const parsed = header.stream ? parseStream(buffer, header, resolveLength) : { start: null, length: 0, end: endObject(buffer, header.streamToken.start).end };
  return Object.freeze({
    reference: Object.freeze({ ...reference }),
    value: header.value,
    stream: header.stream,
    streamStart: parsed.start,
    streamLength: parsed.length,
    start: offset,
    end: parsed.end,
  });
}
function escapedNameByte(byte) { if (byte < 33 || byte > 126) return true; if (delimiter(byte)) return true; return byte === 0x23; }
function encodeName(value) { const bytes = Buffer.from(value, 'latin1'); let result = '/'; for (const byte of bytes) result += escapedNameByte(byte) ? `#${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte); return result; }
function serializeNumber(value) {
  if (!Number.isFinite(value.value)) throw invalid();
  if (typeof value.raw === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.raw)) return value.raw;
  const result = Object.is(value.value, -0) ? '0' : String(value.value);
  if (/[eE]/.test(result)) throw invalid();
  return result;
}
function serializeReference(value) {
  if (!Number.isSafeInteger(value.object) || value.object < 1) throw invalid();
  if (!Number.isSafeInteger(value.generation) || value.generation < 0 || value.generation > 65_535) throw invalid();
  return `${value.object} ${value.generation} R`;
}
function serializeArray(value) { return `[${value.values.map(serializePdfValue).join(' ')}]`; }
function serializeDictionary(value) { const entries = [...value.entries].sort(([left], [right]) => Buffer.from(left, 'latin1').compare(Buffer.from(right, 'latin1'))); return `<<${entries.map(([key, entry]) => ` ${encodeName(key)} ${serializePdfValue(entry)}`).join('')} >>`; }
function serializeNull() { return 'null'; }
function serializeBoolean(value) { return value.value ? 'true' : 'false'; }
function serializeName(value) { return encodeName(value.value); }
function serializeString(value) { if (!Buffer.isBuffer(value.bytes)) throw invalid(); return `<${value.bytes.toString('hex').toUpperCase()}>`; }
const SERIALIZERS = new Map([
  ['null', serializeNull],
  ['boolean', serializeBoolean],
  ['number', serializeNumber],
  ['name', serializeName],
  ['string', serializeString],
  ['ref', serializeReference],
  ['array', serializeArray],
  ['dict', serializeDictionary],
]);
export function serializePdfValue(value) {
  const serializer = SERIALIZERS.get(value?.type);
  if (!serializer) throw invalid();
  return serializer(value);
}
export function pdfDictionary(value) { if (value?.type !== 'dict') throw invalid(); return value.entries; }
export function pdfInteger(value) {
  if (value?.type !== 'number') throw invalid();
  if (!value.integer || !integerRaw(value.raw)) throw invalid();
  return value.value;
}
export function pdfReference(value) {
  if (value?.type !== 'ref') throw invalid();
  if (!Number.isSafeInteger(value.object) || value.object < 1) throw invalid();
  if (!Number.isSafeInteger(value.generation) || value.generation < 0 || value.generation > 65_535) throw invalid();
  return value;
}
export function pdfStringBytes(value) { if (value?.type !== 'string') throw invalid(); return value.bytes; }
