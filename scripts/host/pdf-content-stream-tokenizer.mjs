import { decodePdfControlStream } from './pdf-control-stream-filters.mjs';

export const PDF_CONTENT_STREAM_LIMITS = Object.freeze({
  maxEncodedBytes: 8 * 1024 * 1024,
  maxDecodedBytes: 16 * 1024 * 1024,
  maxTokens: 200_000,
  maxNesting: 32,
  maxStringBytes: 64 * 1024,
  maxNameBytes: 256,
});

const SPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITER = new Set([0, 9, 10, 12, 13, 32, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const LITERAL_ESCAPES = new Map([[110, 10], [114, 13], [116, 9], [98, 8], [102, 12]]);
const SINGLE_DELIMITER_TOKENS = new Map([[91, 'array-start'], [93, 'array-end']]);

function invalid() {
  const error = new Error('PDF content stream is malformed or unsupported.');
  error.code = 'INVALID_PDF_CONTENT_STREAM';
  return error;
}
function nibble(byte) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return -1;
}
function checkLimits(limits) {
  const result = { ...PDF_CONTENT_STREAM_LIMITS, ...(limits ?? {}) };
  for (const key of Object.keys(PDF_CONTENT_STREAM_LIMITS)) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > PDF_CONTENT_STREAM_LIMITS[key]) throw invalid();
  }
  return result;
}

function advanceComment(lexer) {
  while (lexer.position < lexer.bytes.length && ![10, 13].includes(lexer.bytes[lexer.position])) lexer.position += 1;
}

function octalLiteralEscape(lexer, first) {
  let value = first - 48;
  for (let count = 1; count < 3 && lexer.bytes[lexer.position] >= 48 && lexer.bytes[lexer.position] <= 55; count += 1) {
    value = (value * 8) + lexer.bytes[lexer.position++] - 48;
  }
  if (value > 255) throw invalid();
  return value;
}

function consumeLiteralEscape(lexer, output) {
  if (lexer.position >= lexer.bytes.length) throw invalid();
  const byte = lexer.bytes[lexer.position++];
  const escaped = LITERAL_ESCAPES.get(byte);
  if (escaped !== undefined) return output.push(escaped);
  if (byte === 10) return undefined;
  if (byte === 13) {
    if (lexer.bytes[lexer.position] === 10) lexer.position += 1;
    return undefined;
  }
  if (byte >= 48 && byte <= 55) return output.push(octalLiteralEscape(lexer, byte));
  return output.push(byte);
}

function consumeLiteralCharacter(lexer, output) {
  const byte = lexer.bytes[lexer.position++];
  if (byte === 92) {
    consumeLiteralEscape(lexer, output);
    return 0;
  }
  if (byte === 40) { output.push(byte); return 1; }
  if (byte === 41) return -1;
  if (byte === 13 && lexer.bytes[lexer.position] === 10) lexer.position += 1;
  output.push(byte === 13 ? 10 : byte);
  return 0;
}

function delimiterToken(lexer, start) {
  const byte = lexer.bytes[lexer.position];
  if (byte === 60 && lexer.bytes[lexer.position + 1] === 60) {
    lexer.position += 2;
    return Object.freeze({ type: 'dict-start', start, end: lexer.position });
  }
  if (byte === 62 && lexer.bytes[lexer.position + 1] === 62) {
    lexer.position += 2;
    return Object.freeze({ type: 'dict-end', start, end: lexer.position });
  }
  const type = SINGLE_DELIMITER_TOKENS.get(byte);
  if (!type) return null;
  lexer.position += 1;
  return Object.freeze({ type, start, end: lexer.position });
}

function wordToken(lexer, start) {
  while (lexer.position < lexer.bytes.length && !DELIMITER.has(lexer.bytes[lexer.position])) lexer.position += 1;
  if (start === lexer.position) throw invalid();
  const raw = lexer.bytes.subarray(start, lexer.position).toString('latin1');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(raw)) {
    return Object.freeze({ type: 'operator', value: raw, start, end: lexer.position });
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw invalid();
  return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw, start, end: lexer.position });
}

class ContentLexer {
  constructor(bytes, limits) { this.bytes = bytes; this.position = 0; this.limits = limits; }
  trivia() {
    while (this.position < this.bytes.length) {
      if (SPACE.has(this.bytes[this.position])) { this.position += 1; continue; }
      if (this.bytes[this.position] !== 37) return;
      advanceComment(this);
    }
  }
  literal(start) {
    const bytes = []; let depth = 1; this.position += 1;
    while (this.position < this.bytes.length && depth > 0) {
      const change = consumeLiteralCharacter(this, bytes);
      depth += change;
      if (change < 0 && depth > 0) bytes.push(41);
      if (depth > this.limits.maxNesting || bytes.length > this.limits.maxStringBytes) throw invalid();
    }
    if (depth !== 0) throw invalid();
    return Object.freeze({ type: 'string', format: 'literal', bytes: Buffer.from(bytes), start, end: this.position });
  }
  hex(start) {
    const digits = []; this.position += 1;
    while (this.position < this.bytes.length && this.bytes[this.position] !== 62) {
      const byte = this.bytes[this.position++]; if (SPACE.has(byte)) continue;
      const value = nibble(byte); if (value < 0 || digits.length >= this.limits.maxStringBytes * 2) throw invalid(); digits.push(value);
    }
    if (this.bytes[this.position] !== 62) throw invalid(); this.position += 1;
    const output = Buffer.alloc(Math.ceil(digits.length / 2));
    for (let index = 0; index < digits.length; index += 2) output[index / 2] = (digits[index] << 4) | (digits[index + 1] ?? 0);
    return Object.freeze({ type: 'string', format: 'hex', bytes: output, start, end: this.position });
  }
  name(start) {
    const bytes = []; this.position += 1;
    while (this.position < this.bytes.length && !DELIMITER.has(this.bytes[this.position])) {
      const byte = this.bytes[this.position++];
      if (byte === 35) { const high = nibble(this.bytes[this.position]); const low = nibble(this.bytes[this.position + 1]); if (high < 0 || low < 0) throw invalid(); bytes.push((high << 4) | low); this.position += 2; }
      else bytes.push(byte);
      if (bytes.length > this.limits.maxNameBytes) throw invalid();
    }
    return Object.freeze({ type: 'name', value: Buffer.from(bytes).toString('latin1'), start, end: this.position });
  }
  next() {
    this.trivia(); const start = this.position;
    if (start >= this.bytes.length) return Object.freeze({ type: 'eof', start, end: start });
    const byte = this.bytes[this.position];
    const delimiter = delimiterToken(this, start);
    if (delimiter) return delimiter;
    if (byte === 40) return this.literal(start);
    if (byte === 60) return this.hex(start);
    if (byte === 47) return this.name(start);
    return wordToken(this, start);
  }
}

function validStreamSlice(source, stream) {
  if (!Buffer.isBuffer(source)) return false;
  if (!Number.isSafeInteger(stream?.streamStart) || !Number.isSafeInteger(stream?.streamLength)) return false;
  if (stream.streamStart < 0 || stream.streamLength < 0) return false;
  return stream.streamStart + stream.streamLength <= source.length;
}

function encodedBytes(request, stream) {
  if (Buffer.isBuffer(request.encodedBytes)) return request.encodedBytes;
  const source = request.sourceBytes;
  if (!validStreamSlice(source, stream)) throw invalid();
  return source.subarray(stream.streamStart, stream.streamStart + stream.streamLength);
}

function markDictionaryValue(stack) {
  const parent = stack.at(-1);
  if (parent?.kind === 'dict') parent.expectKey = true;
}

function openContainer(stack, token, maximumNesting) {
  const parent = stack.at(-1);
  if (parent?.kind === 'dict') {
    if (parent.expectKey) throw invalid();
    parent.expectKey = true;
  }
  if (stack.length >= maximumNesting) throw invalid();
  stack.push({ kind: token.type === 'array-start' ? 'array' : 'dict', expectKey: token.type === 'dict-start' });
}

function closeArray(stack) {
  if (stack.pop()?.kind !== 'array') throw invalid();
  markDictionaryValue(stack);
}

function closeDictionary(stack) {
  const closed = stack.pop();
  if (closed?.kind !== 'dict' || !closed.expectKey) throw invalid();
  markDictionaryValue(stack);
}

function consumeDictionaryValue(stack, token) {
  const parent = stack.at(-1);
  if (parent?.kind !== 'dict') return;
  if (parent.expectKey) {
    if (token.type !== 'name') throw invalid();
    parent.expectKey = false;
  } else parent.expectKey = true;
}

function numericReference(previous, token) {
  if (token.type !== 'operator' || token.value !== 'R') return false;
  if (previous.length < 2) return false;
  return previous.at(-2).type === 'number' && previous.at(-1).type === 'number';
}

class ContentStructureValidator {
  constructor(limits) { this.limits = limits; this.stack = []; this.previous = []; }
  accept(token) {
    if (token.type === 'array-start' || token.type === 'dict-start') openContainer(this.stack, token, this.limits.maxNesting);
    else if (token.type === 'array-end') closeArray(this.stack);
    else if (token.type === 'dict-end') closeDictionary(this.stack);
    else consumeDictionaryValue(this.stack, token);
    if (numericReference(this.previous, token)) throw invalid();
    this.previous.push(token);
    if (this.previous.length > 3) this.previous.shift();
  }
  complete() { if (this.stack.length) throw invalid(); }
}

function decodedStream(request, limits, stream, encoded) {
  if (encoded.length > limits.maxEncodedBytes) throw invalid();
  const entries = stream.value.entries;
  const budget = request.budget ?? { objectFilterWorkBytes: 0 };
  if (!Number.isSafeInteger(budget.objectFilterWorkBytes) || budget.objectFilterWorkBytes < 0) throw invalid();
  return decodePdfControlStream({ encodedBytes: encoded, filterValue: entries.get('Filter'), decodeParmsValue: entries.get('DecodeParms'), scope: 'object', maximumDecodedBytes: limits.maxDecodedBytes, budget });
}

function lexTokens(bytes, limits) {
  const lexer = new ContentLexer(bytes, limits);
  const validator = new ContentStructureValidator(limits);
  const tokens = [];
  while (true) {
    const token = lexer.next();
    if (token.type === 'eof') break;
    if (tokens.length >= limits.maxTokens || (token.type === 'operator' && token.value === 'BI')) throw invalid();
    validator.accept(token);
    tokens.push(token);
  }
  validator.complete();
  return tokens;
}

export function tokenizePdfContentStream(request = {}) {
  try {
    if (!request || Object.getPrototypeOf(request) !== Object.prototype) throw invalid();
    const limits = checkLimits(request.limits);
    const stream = request.stream ?? request.object;
    if (!stream?.stream || stream.value?.type !== 'dict') throw invalid();
    const encoded = encodedBytes(request, stream);
    const decoded = decodedStream(request, limits, stream, encoded);
    // The decoder intentionally returns the input buffer for an unfiltered stream.
    // Snapshot it before exposing the tokenization result so callers cannot mutate
    // the source stream through the returned bytes.
    const decodedBytes = Buffer.from(decoded.bytes);
    const tokens = lexTokens(decodedBytes, limits);
    return Object.freeze({
      reference: stream.reference ? Object.freeze({ ...stream.reference }) : null,
      encodedBytes: encoded.length,
      decodedBytes: decoded.bytes.length,
      filters: Object.freeze([...decoded.filters]),
      predictor: decoded.predictor ?? null,
      bytes: decodedBytes,
      tokens: Object.freeze(tokens),
    });
  } catch (error) {
    if (error?.code === 'INVALID_PDF_CONTENT_STREAM') throw error;
    throw invalid();
  }
}

export const tokenizePdfContent = tokenizePdfContentStream;
export const parsePdfContentStream = tokenizePdfContentStream;
