const MAX_ITEMS = 20_000;
const MAX_TOTAL_AST_ITEMS = 100_000;
const MAX_TOTAL_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_NAME_BYTES = 256;
const MAX_STRING_BYTES = 64 * 1024;
export const MAX_STREAM_BYTES = 256 * 1024 * 1024;
const MAX_XREF_ENTRIES = 50_000;
const TAIL_BYTES = 64 * 1024;

function invalid() {
  const error = new Error('PDF classic syntax is malformed or unsupported.');
  error.code = 'INVALID_CLASSIC_PDF_SYNTAX';
  return error;
}

function whitespace(byte) {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function delimiter(byte) {
  return whitespace(byte) || [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25].includes(byte);
}

function nibble(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
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
      let byte = this.#buffer[this.#position++];
      if (byte === 0x5c) {
        if (this.#position >= this.#limit) throw invalid();
        byte = this.#buffer[this.#position++];
        const escaped = new Map([[0x6e, 10], [0x72, 13], [0x74, 9], [0x62, 8], [0x66, 12]]).get(byte);
        if (escaped !== undefined) bytes.push(escaped);
        else if (byte === 10) continue;
        else if (byte === 13) { if (this.#buffer[this.#position] === 10) this.#position += 1; }
        else if (byte >= 0x30 && byte <= 0x37) {
          let octal = byte - 0x30;
          for (let count = 1; count < 3 && this.#buffer[this.#position] >= 0x30
            && this.#buffer[this.#position] <= 0x37; count += 1) octal = (octal * 8) + this.#buffer[this.#position++] - 0x30;
          if (octal > 255) throw invalid();
          bytes.push(octal);
        } else bytes.push(byte);
      } else if (byte === 0x28) { depth += 1; bytes.push(byte); }
      else if (byte === 0x29) { depth -= 1; if (depth > 0) bytes.push(byte); }
      else if (byte === 13) { if (this.#buffer[this.#position] === 10) this.#position += 1; bytes.push(10); }
      else bytes.push(byte);
      if (depth > MAX_DEPTH || bytes.length > MAX_STRING_BYTES) throw invalid();
    }
    if (depth !== 0) throw invalid();
    return Object.freeze({ type: 'string', format: 'literal', bytes: Buffer.from(bytes), start, end: this.#position });
  }

  #hex(start) {
    const digits = [];
    this.#position += 1;
    while (this.#position < this.#limit && this.#buffer[this.#position] !== 0x3e) {
      const byte = this.#buffer[this.#position++];
      if (whitespace(byte)) continue;
      if (nibble(byte) < 0 || digits.length >= MAX_STRING_BYTES * 2) throw invalid();
      digits.push(nibble(byte));
    }
    if (this.#buffer[this.#position] !== 0x3e) throw invalid();
    this.#position += 1;
    const bytes = Buffer.alloc(Math.ceil(digits.length / 2));
    for (let index = 0; index < digits.length; index += 2) bytes[index / 2] = (digits[index] << 4) | (digits[index + 1] ?? 0);
    return Object.freeze({ type: 'string', format: 'hex', bytes, start, end: this.#position });
  }

  #name(start) {
    const bytes = [];
    this.#position += 1;
    while (this.#position < this.#limit && !delimiter(this.#buffer[this.#position])) {
      const byte = this.#buffer[this.#position++];
      if (byte === 0x23) {
        const high = nibble(this.#buffer[this.#position]);
        const low = nibble(this.#buffer[this.#position + 1]);
        if (high < 0 || low < 0) throw invalid();
        bytes.push((high << 4) | low); this.#position += 2;
      } else bytes.push(byte);
      if (bytes.length > MAX_NAME_BYTES) throw invalid();
    }
    return Object.freeze({ type: 'name', value: Buffer.from(bytes).toString('latin1'), start, end: this.#position });
  }

  #raw() {
    this.#skipTrivia();
    const start = this.#position;
    if (start >= this.#limit) return Object.freeze({ type: 'eof', start, end: start });
    const byte = this.#buffer[this.#position];
    if (byte === 0x3c && this.#buffer[this.#position + 1] === 0x3c) { this.#position += 2; return { type: 'dictStart', start, end: this.#position }; }
    if (byte === 0x3e && this.#buffer[this.#position + 1] === 0x3e) { this.#position += 2; return { type: 'dictEnd', start, end: this.#position }; }
    if (byte === 0x5b || byte === 0x5d) { this.#position += 1; return { type: byte === 0x5b ? 'arrayStart' : 'arrayEnd', start, end: this.#position }; }
    if (byte === 0x28) return this.#literal(start);
    if (byte === 0x3c) return this.#hex(start);
    if (byte === 0x2f) return this.#name(start);
    while (this.#position < this.#limit && !delimiter(this.#buffer[this.#position])) this.#position += 1;
    if (start === this.#position) throw invalid();
    const raw = this.#buffer.subarray(start, this.#position).toString('latin1');
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw invalid();
      return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw, start, end: this.#position });
    }
    return Object.freeze({ type: 'word', value: raw, start, end: this.#position });
  }

  peek(index = 0) { while (this.#lookahead.length <= index) this.#lookahead.push(this.#raw()); return this.#lookahead[index]; }
  next() { return this.#lookahead.length ? this.#lookahead.shift() : this.#raw(); }
}

function parseValue(lexer, state, depth = 0) {
  state.items += 1;
  state.budget.items += 1;
  if (state.items > MAX_ITEMS || state.budget.items > MAX_TOTAL_AST_ITEMS || depth > MAX_DEPTH) throw invalid();
  const token = lexer.next();
  if (token.type === 'number') {
    if (token.integer && /^[+-]?\d+$/.test(token.raw)
      && lexer.peek().type === 'number' && lexer.peek().integer
      && /^[+-]?\d+$/.test(lexer.peek().raw)
      && lexer.peek(1).type === 'word' && lexer.peek(1).value === 'R') {
      const generation = lexer.next(); lexer.next();
      if (token.value < 1 || generation.value < 0 || generation.value > 65_535) throw invalid();
      return Object.freeze({ type: 'ref', object: token.value, generation: generation.value });
    }
    return Object.freeze({ type: 'number', value: token.value, integer: token.integer, raw: token.raw });
  }
  if (token.type === 'word') {
    if (token.value === 'true' || token.value === 'false') return Object.freeze({ type: 'boolean', value: token.value === 'true' });
    if (token.value === 'null') return Object.freeze({ type: 'null' });
    throw invalid();
  }
  if (token.type === 'string') {
    state.budget.decodedBytes += token.bytes.length;
    if (state.budget.decodedBytes > MAX_TOTAL_DECODED_BYTES) throw invalid();
    return Object.freeze({ type: 'string', format: token.format, bytes: token.bytes });
  }
  if (token.type === 'name') {
    state.budget.decodedBytes += Buffer.byteLength(token.value, 'latin1');
    if (state.budget.decodedBytes > MAX_TOTAL_DECODED_BYTES) throw invalid();
    return Object.freeze({ type: 'name', value: token.value });
  }
  if (token.type === 'arrayStart') {
    const values = [];
    while (lexer.peek().type !== 'arrayEnd') { if (lexer.peek().type === 'eof') throw invalid(); values.push(parseValue(lexer, state, depth + 1)); }
    lexer.next(); return Object.freeze({ type: 'array', values: Object.freeze(values) });
  }
  if (token.type === 'dictStart') {
    const entries = new Map();
    while (lexer.peek().type !== 'dictEnd') {
      const key = lexer.next();
      if (key.type !== 'name' || entries.has(key.value)) throw invalid();
      state.budget.decodedBytes += Buffer.byteLength(key.value, 'latin1');
      if (state.budget.decodedBytes > MAX_TOTAL_DECODED_BYTES) throw invalid();
      entries.set(key.value, parseValue(lexer, state, depth + 1));
    }
    lexer.next(); return Object.freeze({ type: 'dict', entries });
  }
  throw invalid();
}

function exactWord(token, value) { if (token.type !== 'word' || token.value !== value) throw invalid(); }
function unsigned(token) { if (token.type !== 'number' || !token.integer || token.value < 0 || !/^\d+$/.test(token.raw)) throw invalid(); return token.value; }
function skipWhitespace(buffer, position) { while (position < buffer.length && whitespace(buffer[position])) position += 1; return position; }
function asciiAt(buffer, position, value) { return buffer.subarray(position, position + value.length).toString('latin1') === value; }
function lineStart(buffer, position) { return position === 0 || buffer[position - 1] === 10 || buffer[position - 1] === 13; }
function syntaxBudget(sharedBudget) {
  const budget = sharedBudget ?? { items: 0, decodedBytes: 0 };
  if (!Number.isSafeInteger(budget.items) || budget.items < 0
    || !Number.isSafeInteger(budget.decodedBytes) || budget.decodedBytes < 0) throw invalid();
  return budget;
}

// Parses exactly one non-stream PDF value from a bounded byte slice.  Object
// streams use this to retain the same AST and resource limits as indirect
// objects without accepting a second value or unconsumed member bytes.
export function parsePdfValueSlice(buffer, start = 0, end = buffer?.length, sharedBudget = null) {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end > buffer.length) throw invalid();
  const lexer = new Lexer(buffer, start, end);
  const value = parseValue(lexer, { items: 0, budget: syntaxBudget(sharedBudget) });
  const tail = lexer.next();
  if (tail.type !== 'eof') throw invalid();
  return value;
}

export function findFinalStartXref(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) throw invalid();
  const start = Math.max(0, buffer.length - TAIL_BYTES);
  const match = /startxref[\x00\x09\x0a\x0c\x0d\x20]+([0-9]+)[\x00\x09\x0a\x0c\x0d\x20]+%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.exec(buffer.subarray(start).toString('latin1'));
  const markerOffset = match ? start + match.index : -1;
  const offset = Number(match?.[1]);
  if (!lineStart(buffer, markerOffset)
    || !Number.isSafeInteger(offset) || offset < 0 || offset >= buffer.length) throw invalid();
  return offset;
}

export function parseClassicXrefSection(buffer, offset, sharedBudget = null) {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0
    || offset >= buffer.length || !lineStart(buffer, offset)) throw invalid();
  const lexer = new Lexer(buffer, offset);
  const marker = lexer.next();
  if (marker.start !== offset) throw invalid();
  exactWord(marker, 'xref');
  const entries = [];
  const objects = new Set();
  while (true) {
    const firstToken = lexer.next();
    if (firstToken.type === 'word' && firstToken.value === 'trailer') break;
    const first = unsigned(firstToken);
    const count = unsigned(lexer.next());
    if (count < 1 || first + count > MAX_XREF_ENTRIES || entries.length + count > MAX_XREF_ENTRIES) throw invalid();
    for (let index = 0; index < count; index += 1) {
      const offsetToken = lexer.next(); const generationToken = lexer.next(); const status = lexer.next();
      if (!/^\d{10}$/.test(offsetToken.raw ?? '') || !/^\d{5}$/.test(generationToken.raw ?? '')
        || status.type !== 'word' || !['n', 'f'].includes(status.value)) throw invalid();
      const object = first + index;
      if (objects.has(object)) throw invalid();
      objects.add(object);
      const objectOffset = unsigned(offsetToken); const generation = unsigned(generationToken);
      if (generation > 65_535 || (status.value === 'n' && (object === 0 || objectOffset >= offset))) throw invalid();
      if (object === 0 && (status.value !== 'f' || generation !== 65_535)) throw invalid();
      entries.push(Object.freeze({ object, generation, offset: objectOffset, status: status.value }));
    }
  }
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
  return Object.freeze({ offset, entries: Object.freeze(entries), trailer: trailer.entries, revisionEnd: eof });
}

export function parseIndirectObjectHeader(buffer, offset, reference, sharedBudget = null) {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0
    || offset >= buffer.length || !lineStart(buffer, offset)) throw invalid();
  const budget = syntaxBudget(sharedBudget);
  const lexer = new Lexer(buffer, offset);
  const object = lexer.next(); const generation = lexer.next(); const marker = lexer.next();
  if (object.start !== offset || unsigned(object) !== reference.object || unsigned(generation) !== reference.generation) throw invalid();
  exactWord(marker, 'obj');
  const value = parseValue(lexer, { items: 0, budget });
  let next = lexer.next();
  if (!(next.type === 'word' && (next.value === 'stream' || next.value === 'endobj'))) throw invalid();
  return Object.freeze({
    reference: Object.freeze({ ...reference }), value, stream: next.value === 'stream', streamToken: next,
  });
}

export function parsePdfIndirectObject(buffer, offset, reference, sharedBudget = null, { resolveLength } = {}) {
  const header = parseIndirectObjectHeader(buffer, offset, reference, sharedBudget);
  const { value } = header;
  let next = header.streamToken;
  let stream = false;
  let streamStart = null;
  let streamLength = 0;
  if (header.stream) {
    stream = true;
    if (value.type !== 'dict') throw invalid();
    const lengthValue = value.entries.get('Length');
    const length = lengthValue?.type === 'ref'
      ? resolveLength?.(lengthValue)
      : pdfInteger(lengthValue);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STREAM_BYTES) throw invalid();
    let dataStart = next.end;
    if (buffer[dataStart] === 13 && buffer[dataStart + 1] === 10) dataStart += 2;
    else if (buffer[dataStart] === 10) dataStart += 1;
    else throw invalid();
    if (length > buffer.length - dataStart) throw invalid();
    streamStart = dataStart;
    streamLength = length;
    let endstream = dataStart + length;
    if (!asciiAt(buffer, endstream, 'endstream')) {
      if (buffer[endstream] === 13 && buffer[endstream + 1] === 10) endstream += 2;
      else if (buffer[endstream] === 10 || buffer[endstream] === 13) endstream += 1;
    }
    if (!asciiAt(buffer, endstream, 'endstream') || !delimiter(buffer[endstream + 9])) throw invalid();
    const tail = new Lexer(buffer, endstream + 9);
    next = tail.next();
    exactWord(next, 'endobj');
  } else exactWord(next, 'endobj');
  return Object.freeze({
    reference: Object.freeze({ ...reference }),
    value,
    stream,
    streamStart,
    streamLength,
    start: offset,
    end: next.end,
  });
}

function encodeName(value) {
  const bytes = Buffer.from(value, 'latin1');
  let result = '/';
  for (const byte of bytes) result += byte < 33 || byte > 126 || delimiter(byte) || byte === 0x23
    ? `#${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte);
  return result;
}

export function serializePdfValue(value) {
  if (value?.type === 'null') return 'null';
  if (value?.type === 'boolean') return value.value ? 'true' : 'false';
  if (value?.type === 'number' && Number.isFinite(value.value)) {
    if (typeof value.raw === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.raw)) return value.raw;
    const result = Object.is(value.value, -0) ? '0' : String(value.value);
    if (/[eE]/.test(result)) throw invalid();
    return result;
  }
  if (value?.type === 'name') return encodeName(value.value);
  if (value?.type === 'string' && Buffer.isBuffer(value.bytes)) return `<${value.bytes.toString('hex').toUpperCase()}>`;
  if (value?.type === 'ref' && Number.isSafeInteger(value.object) && value.object > 0
    && Number.isSafeInteger(value.generation) && value.generation >= 0 && value.generation <= 65_535) {
    return `${value.object} ${value.generation} R`;
  }
  if (value?.type === 'array') return `[${value.values.map(serializePdfValue).join(' ')}]`;
  if (value?.type === 'dict') {
    const entries = [...value.entries].sort(([left], [right]) => Buffer.from(left, 'latin1').compare(Buffer.from(right, 'latin1')));
    return `<<${entries.map(([key, entry]) => ` ${encodeName(key)} ${serializePdfValue(entry)}`).join('')} >>`;
  }
  throw invalid();
}

export function pdfDictionary(value) { if (value?.type !== 'dict') throw invalid(); return value.entries; }
export function pdfInteger(value) { if (value?.type !== 'number' || !value.integer || !/^[+-]?\d+$/.test(value.raw)) throw invalid(); return value.value; }
export function pdfReference(value) {
  if (value?.type !== 'ref' || !Number.isSafeInteger(value.object) || value.object < 1
    || !Number.isSafeInteger(value.generation) || value.generation < 0 || value.generation > 65_535) throw invalid();
  return value;
}
export function pdfStringBytes(value) { if (value?.type !== 'string') throw invalid(); return value.bytes; }
