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

class ContentLexer {
  constructor(bytes, limits) { this.bytes = bytes; this.position = 0; this.limits = limits; }
  trivia() {
    while (this.position < this.bytes.length) {
      if (SPACE.has(this.bytes[this.position])) { this.position += 1; continue; }
      if (this.bytes[this.position] !== 37) return;
      while (this.position < this.bytes.length && ![10, 13].includes(this.bytes[this.position])) this.position += 1;
    }
  }
  literal(start) {
    const bytes = []; let depth = 1; this.position += 1;
    while (this.position < this.bytes.length && depth > 0) {
      let byte = this.bytes[this.position++];
      if (byte === 92) {
        if (this.position >= this.bytes.length) throw invalid();
        byte = this.bytes[this.position++];
        const escaped = new Map([[110, 10], [114, 13], [116, 9], [98, 8], [102, 12]]).get(byte);
        if (escaped !== undefined) bytes.push(escaped);
        else if (byte === 10) { /* line continuation */ }
        else if (byte === 13) { if (this.bytes[this.position] === 10) this.position += 1; }
        else if (byte >= 48 && byte <= 55) {
          let value = byte - 48;
          for (let count = 1; count < 3 && this.bytes[this.position] >= 48 && this.bytes[this.position] <= 55; count += 1) value = (value * 8) + this.bytes[this.position++] - 48;
          if (value > 255) throw invalid(); bytes.push(value);
        } else bytes.push(byte);
      } else if (byte === 40) { depth += 1; bytes.push(byte); }
      else if (byte === 41) { depth -= 1; if (depth > 0) bytes.push(byte); }
      else if (byte === 13) { if (this.bytes[this.position] === 10) this.position += 1; bytes.push(10); }
      else bytes.push(byte);
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
    if (byte === 60 && this.bytes[this.position + 1] === 60) { this.position += 2; return Object.freeze({ type: 'dict-start', start, end: this.position }); }
    if (byte === 62 && this.bytes[this.position + 1] === 62) { this.position += 2; return Object.freeze({ type: 'dict-end', start, end: this.position }); }
    if (byte === 91 || byte === 93) { this.position += 1; return Object.freeze({ type: byte === 91 ? 'array-start' : 'array-end', start, end: this.position }); }
    if (byte === 40) return this.literal(start);
    if (byte === 60) return this.hex(start);
    if (byte === 47) return this.name(start);
    while (this.position < this.bytes.length && !DELIMITER.has(this.bytes[this.position])) this.position += 1;
    if (start === this.position) throw invalid();
    const raw = this.bytes.subarray(start, this.position).toString('latin1');
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(raw)) { const value = Number(raw); if (!Number.isFinite(value)) throw invalid(); return Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw, start, end: this.position }); }
    return Object.freeze({ type: 'operator', value: raw, start, end: this.position });
  }
}

function encodedBytes(request, stream) {
  if (Buffer.isBuffer(request.encodedBytes)) return request.encodedBytes;
  const source = request.sourceBytes;
  if (!Buffer.isBuffer(source) || !Number.isSafeInteger(stream?.streamStart) || !Number.isSafeInteger(stream?.streamLength)
    || stream.streamStart < 0 || stream.streamLength < 0 || stream.streamStart + stream.streamLength > source.length) throw invalid();
  return source.subarray(stream.streamStart, stream.streamStart + stream.streamLength);
}

export function tokenizePdfContentStream(request = {}) {
  try {
    if (!request || Object.getPrototypeOf(request) !== Object.prototype) throw invalid();
    const limits = checkLimits(request.limits);
    const stream = request.stream ?? request.object;
    if (!stream?.stream || stream.value?.type !== 'dict') throw invalid();
    const encoded = encodedBytes(request, stream);
    if (encoded.length > limits.maxEncodedBytes) throw invalid();
    const entries = stream.value.entries;
    const budget = request.budget ?? { objectFilterWorkBytes: 0 };
    if (!Number.isSafeInteger(budget.objectFilterWorkBytes) || budget.objectFilterWorkBytes < 0) throw invalid();
    const decoded = decodePdfControlStream({ encodedBytes: encoded, filterValue: entries.get('Filter'), decodeParmsValue: entries.get('DecodeParms'), scope: 'object', maximumDecodedBytes: limits.maxDecodedBytes, budget });
    // The decoder intentionally returns the input buffer for an unfiltered stream.
    // Snapshot it before exposing the tokenization result so callers cannot mutate
    // the source stream through the returned bytes.
    const decodedBytes = Buffer.from(decoded.bytes);
    const lexer = new ContentLexer(decodedBytes, limits); const tokens = []; const stack = [];
    let previous = [];
    while (true) {
      const token = lexer.next(); if (token.type === 'eof') break;
      if (tokens.length >= limits.maxTokens) throw invalid();
      if (token.type === 'operator' && token.value === 'BI') throw invalid();
      const top = stack.at(-1);
      if (token.type === 'array-start' || token.type === 'dict-start') {
        if (top?.kind === 'dict') {
          if (top.expectKey) throw invalid();
          top.expectKey = true;
        }
        if (stack.length >= limits.maxNesting) throw invalid();
        stack.push({ kind: token.type === 'array-start' ? 'array' : 'dict', expectKey: token.type === 'dict-start' });
      } else if (token.type === 'array-end') {
        if (stack.pop()?.kind !== 'array') throw invalid();
        if (stack.at(-1)?.kind === 'dict') stack.at(-1).expectKey = true;
      } else if (token.type === 'dict-end') {
        const closed = stack.pop(); if (closed?.kind !== 'dict' || !closed.expectKey) throw invalid();
        if (stack.at(-1)?.kind === 'dict') stack.at(-1).expectKey = true;
      } else if (top?.kind === 'dict') {
        if (top.expectKey) { if (token.type !== 'name') throw invalid(); top.expectKey = false; }
        else top.expectKey = true;
      }
      if (token.type === 'operator' && token.value === 'R' && previous.length >= 2 && previous.at(-2).type === 'number' && previous.at(-1).type === 'number') throw invalid();
      tokens.push(token); previous.push(token); if (previous.length > 3) previous.shift();
    }
    if (stack.length) throw invalid();
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
