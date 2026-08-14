import { deflateSync, inflateSync } from 'node:zlib';
import { HostError } from './host-error.mjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_PNG_PIXELS = 8_294_400;
export const MAX_PNG_EDGE = 8_192;
export const MAX_PNG_INPUT_BYTES = 16 * 1024 * 1024;
const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 2: 3, 6: 4 });
const ANIMATED_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT']);
const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
}));

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkBounds(buffer, offset) {
  if (!Number.isSafeInteger(offset) || offset < 8 || offset > buffer.length - 12) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has a truncated chunk.', 502);
  }
  const length = buffer.readUInt32BE(offset);
  if (length > 0x7fffffff) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has an invalid chunk length.', 502);
  }
  const dataStart = offset + 8;
  const dataEnd = dataStart + length;
  const next = dataEnd + 4;
  if (!Number.isSafeInteger(next) || next > buffer.length) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has a truncated chunk.', 502);
  }
  return { length, dataStart, dataEnd, next };
}

function chunkType(typeBytes) {
  if ([...typeBytes].some((byte) => !((byte >= 65 && byte <= 90)
    || (byte >= 97 && byte <= 122))) || (typeBytes[2] & 32)) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has an invalid chunk type.', 502);
  }
  return typeBytes.toString('ascii');
}

function verifyChunkCrc(buffer, type, offset, dataEnd) {
  if (crc32(buffer.subarray(offset + 4, dataEnd)) !== buffer.readUInt32BE(dataEnd)) {
    fail('INVALID_RENDER_OUTPUT', `Rendered PNG ${type} chunk failed its CRC check.`, 502);
  }
}

function readChunk(buffer, offset) {
  const { length, dataStart, dataEnd, next } = chunkBounds(buffer, offset);
  const typeBytes = buffer.subarray(offset + 4, offset + 8);
  const type = chunkType(typeBytes);
  verifyChunkCrc(buffer, type, offset, dataEnd);
  return { length, type, typeBytes, data: buffer.subarray(dataStart, dataEnd), next };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function validPngEdge(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PNG_EDGE;
}

function validPngDimensions(width, height, maximumPixels) {
  if (!validPngEdge(width) || !validPngEdge(height)) return false;
  return width <= Math.floor(maximumPixels / height);
}

function assertHeaderRasterShape({ width, height, bitDepth, channels, maximumPixels }) {
  if (!validPngDimensions(width, height, maximumPixels)) {
    fail('UNSUPPORTED_RENDER_PNG', 'Rendered PNG must be bounded 8-bit RGB or RGBA.', 422);
  }
  if (bitDepth !== 8 || !channels) {
    fail('UNSUPPORTED_RENDER_PNG', 'Rendered PNG must be bounded 8-bit RGB or RGBA.', 422);
  }
}

function parseHeader(chunk, maximumPixels) {
  if (chunk.length !== 13) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG must contain one 13-byte IHDR chunk.', 502);
  }
  const width = chunk.data.readUInt32BE(0);
  const height = chunk.data.readUInt32BE(4);
  const colorType = chunk.data[9];
  const channels = CHANNELS_BY_COLOR_TYPE[colorType] ?? 0;
  assertHeaderRasterShape({
    width,
    height,
    bitDepth: chunk.data[8],
    channels,
    maximumPixels,
  });
  if (chunk.data[10] !== 0 || chunk.data[11] !== 0) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG uses an invalid compression or filter method.', 502);
  }
  if (chunk.data[12] !== 0) {
    fail('UNSUPPORTED_RENDER_PNG', 'Interlaced rendered PNGs are unsupported.', 422);
  }
  return { width, height, colorType, expectedRawLength: ((width * channels) + 1) * height };
}

function createPngParseState() {
  return {
    offset: 8,
    width: undefined,
    height: undefined,
    colorType: undefined,
    expectedRawLength: undefined,
    idatLength: 0,
    sawHeader: false,
    sawPalette: false,
    sawData: false,
    dataEnded: false,
    sawEnd: false,
    chunks: [],
  };
}

function acceptHeader(state, chunk, maximumPixels) {
  if (state.sawHeader) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG must contain one 13-byte IHDR chunk.', 502);
  }
  Object.assign(state, parseHeader(chunk, maximumPixels), { sawHeader: true });
}

function validPaletteChunk(state, chunk) {
  if (state.sawPalette || state.sawData) return false;
  if (chunk.length < 3 || chunk.length > 768) return false;
  return chunk.length % 3 === 0;
}

function acceptPalette(state, chunk) {
  if (!validPaletteChunk(state, chunk)) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has an invalid PLTE chunk.', 502);
  }
  state.sawPalette = true;
}

function acceptData(state, chunk) {
  if (state.dataEnded) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG IDAT chunks must be consecutive.', 502);
  }
  state.sawData = true;
  state.idatLength += chunk.length;
  if (!Number.isSafeInteger(state.idatLength)
    || state.idatLength > state.expectedRawLength + 65_536) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG compressed data exceeds its bounded raster size.', 502);
  }
  state.chunks.push(chunk.data);
}

function acceptEnd(state, chunk, isLastChunk) {
  if (!state.sawData || chunk.length !== 0) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has an invalid IEND chunk.', 502);
  }
  state.sawEnd = true;
  if (!isLastChunk) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has data after IEND.', 502);
  }
}

function acceptAncillaryChunk(state, chunk) {
  if ((chunk.typeBytes[0] & 32) === 0) {
    fail('UNSUPPORTED_RENDER_PNG', `Rendered PNG uses unsupported critical chunk ${chunk.type}.`, 422);
  }
  if (state.sawData) state.dataEnded = true;
}

function rejectTransparencyKey() {
  fail('UNSUPPORTED_RENDER_PNG', 'Rendered PNG transparency keys are unsupported; use explicit RGBA samples.', 422);
}

function acceptEndChunk(state, chunk, _maximumPixels, isLastChunk) {
  return acceptEnd(state, chunk, isLastChunk);
}

const CHUNK_HANDLERS = Object.freeze({
  IHDR: acceptHeader,
  tRNS: rejectTransparencyKey,
  PLTE: acceptPalette,
  IDAT: acceptData,
  IEND: acceptEndChunk,
});

function acceptChunk(state, chunk, maximumPixels, isLastChunk) {
  if (!state.sawHeader && chunk.type !== 'IHDR') {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG must begin with one IHDR chunk.', 502);
  }
  if (ANIMATED_CHUNKS.has(chunk.type)) {
    fail('UNSUPPORTED_RENDER_PNG', 'Animated PNGs are unsupported.', 422);
  }
  const handler = CHUNK_HANDLERS[chunk.type];
  if (handler) return handler(state, chunk, maximumPixels, isLastChunk);
  return acceptAncillaryChunk(state, chunk);
}

function parsePngChunks(png, maximumPixels) {
  const state = createPngParseState();
  while (state.offset < png.length) {
    const chunk = readChunk(png, state.offset);
    state.offset = chunk.next;
    acceptChunk(state, chunk, maximumPixels, state.offset === png.length);
    if (state.sawEnd) break;
  }
  if (!state.sawHeader || !state.sawData || !state.sawEnd) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG is missing a required chunk.', 502);
  }
  return state;
}

function inflateScanlines(parsed) {
  try {
    const inflated = inflateSync(Buffer.concat(parsed.chunks, parsed.idatLength), {
      info: true,
      maxOutputLength: parsed.expectedRawLength,
    });
    if (inflated.engine.bytesWritten !== parsed.idatLength
      || inflated.buffer.length !== parsed.expectedRawLength) {
      fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has invalid scanline data.', 502);
    }
    return inflated.buffer;
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has invalid or oversized compressed scanline data.', 502);
  }
}

function filterPredictor(filter, left, above, upperLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return above;
  if (filter === 3) return Math.floor((left + above) / 2);
  if (filter === 4) return paeth(left, above, upperLeft);
  fail('INVALID_RENDER_OUTPUT', 'Rendered PNG uses an invalid filter.', 502);
}

function unfilterRow(row, previous, filter, channels) {
  for (let x = 0; x < row.length; x += 1) {
    const left = x >= channels ? row[x - channels] : 0;
    const above = previous[x];
    const upperLeft = x >= channels ? previous[x - channels] : 0;
    row[x] = (row[x] + filterPredictor(filter, left, above, upperLeft)) & 255;
  }
}

function copyRgbaRow({ pixels, destination, row, width, channels }) {
  for (let x = 0; x < width; x += 1) {
    const source = x * channels;
    pixels[destination++] = row[source];
    pixels[destination++] = row[source + 1];
    pixels[destination++] = row[source + 2];
    pixels[destination++] = channels === 4 ? row[source + 3] : 255;
  }
  return destination;
}

function decodeScanlines(raw, width, height, channels) {
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let source = 0;
  let previous = Buffer.alloc(stride);
  let destination = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++];
    const row = Buffer.from(raw.subarray(source, source + stride));
    source += stride;
    unfilterRow(row, previous, filter, channels);
    destination = copyRgbaRow({ pixels, destination, row, width, channels });
    previous = row;
  }
  return pixels;
}

export function decodePng(png, maximumPixels = 8_294_400) {
  if (!Buffer.isBuffer(png) || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered page is not a PNG image.', 502);
  }
  if (png.length > MAX_PNG_INPUT_BYTES) {
    fail('RENDER_OUTPUT_LIMIT', 'Rendered PNG exceeds the local input byte limit.', 413);
  }
  if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1
    || maximumPixels > MAX_PNG_PIXELS) {
    fail('INVALID_LIMITS', `PNG pixel limits must be integers from 1 through ${MAX_PNG_PIXELS}.`);
  }
  const parsed = parsePngChunks(png, maximumPixels);
  const channels = parsed.colorType === 2 ? 3 : 4;
  const pixels = decodeScanlines(
    inflateScanlines(parsed), parsed.width, parsed.height, channels,
  );
  return Object.freeze({ width: parsed.width, height: parsed.height, pixels });
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function assertRgbaPngInput(width, height, pixels) {
  if (!validPngDimensions(width, height, MAX_PNG_PIXELS)
    || !Buffer.isBuffer(pixels) || pixels.length !== width * height * 4) {
    fail(
      'INVALID_PNG_PIXELS',
      'RGBA PNG input must contain bounded dimensions and exactly four bytes per pixel.',
    );
  }
}

function rgbaScanlines(width, height, pixels) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return raw;
}

function rgbaHeader(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return header;
}

export function encodeRgbaPng({ width, height, pixels }) {
  assertRgbaPngInput(width, height, pixels);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', rgbaHeader(width, height)),
    pngChunk('IDAT', deflateSync(rgbaScanlines(width, height, pixels))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
