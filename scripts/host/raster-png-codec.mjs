import { deflateSync, inflateSync } from 'node:zlib';
import { HostError } from './host-error.mjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_PNG_PIXELS = 8_294_400;
export const MAX_PNG_EDGE = 8_192;
export const MAX_PNG_INPUT_BYTES = 16 * 1024 * 1024;
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

function readChunk(buffer, offset) {
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
  const typeBytes = buffer.subarray(offset + 4, offset + 8);
  const type = typeBytes.toString('ascii');
  if ([...typeBytes].some((byte) => !((byte >= 65 && byte <= 90)
    || (byte >= 97 && byte <= 122))) || (typeBytes[2] & 32)) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has an invalid chunk type.', 502);
  }
  const expectedCrc = buffer.readUInt32BE(dataEnd);
  const actualCrc = crc32(buffer.subarray(offset + 4, dataEnd));
  if (actualCrc !== expectedCrc) {
    fail('INVALID_RENDER_OUTPUT', `Rendered PNG ${type} chunk failed its CRC check.`, 502);
  }
  return { length, type, typeBytes, data: buffer.subarray(dataStart, dataEnd), next };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function parsePngChunks(png, maximumPixels) {
  let offset = 8;
  let width;
  let height;
  let colorType;
  let expectedRawLength;
  let idatLength = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawData = false;
  let dataEnded = false;
  let sawEnd = false;
  const chunks = [];
  while (offset < png.length) {
    const chunk = readChunk(png, offset);
    offset = chunk.next;
    if (!sawHeader && chunk.type !== 'IHDR') {
      fail('INVALID_RENDER_OUTPUT', 'Rendered PNG must begin with one IHDR chunk.', 502);
    }
    if (chunk.type === 'acTL' || chunk.type === 'fcTL' || chunk.type === 'fdAT') {
      fail('UNSUPPORTED_RENDER_PNG', 'Animated PNGs are unsupported.', 422);
    } else if (chunk.type === 'IHDR') {
      if (sawHeader || chunk.length !== 13) {
        fail('INVALID_RENDER_OUTPUT', 'Rendered PNG must contain one 13-byte IHDR chunk.', 502);
      }
      sawHeader = true;
      width = chunk.data.readUInt32BE(0);
      height = chunk.data.readUInt32BE(4);
      const bitDepth = chunk.data[8];
      colorType = chunk.data[9];
      const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
      if (!width || !height || width > MAX_PNG_EDGE || height > MAX_PNG_EDGE
        || width > Math.floor(maximumPixels / height)
        || bitDepth !== 8 || !channels) {
        fail('UNSUPPORTED_RENDER_PNG', 'Rendered PNG must be bounded 8-bit RGB or RGBA.', 422);
      }
      if (chunk.data[10] !== 0 || chunk.data[11] !== 0) {
        fail('INVALID_RENDER_OUTPUT', 'Rendered PNG uses an invalid compression or filter method.', 502);
      }
      if (chunk.data[12] !== 0) {
        fail('UNSUPPORTED_RENDER_PNG', 'Interlaced rendered PNGs are unsupported.', 422);
      }
      expectedRawLength = ((width * channels) + 1) * height;
    } else if (chunk.type === 'tRNS') {
      fail(
        'UNSUPPORTED_RENDER_PNG',
        'Rendered PNG transparency keys are unsupported; use explicit RGBA samples.',
        422,
      );
    } else if (chunk.type === 'PLTE') {
      if (sawPalette || sawData || chunk.length < 3 || chunk.length > 768
        || chunk.length % 3 !== 0) {
        fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has an invalid PLTE chunk.', 502);
      }
      sawPalette = true;
    } else if (chunk.type === 'IDAT') {
      if (dataEnded) {
        fail('INVALID_RENDER_OUTPUT', 'Rendered PNG IDAT chunks must be consecutive.', 502);
      }
      sawData = true;
      idatLength += chunk.length;
      if (!Number.isSafeInteger(idatLength) || idatLength > expectedRawLength + 65_536) {
        fail('INVALID_RENDER_OUTPUT', 'Rendered PNG compressed data exceeds its bounded raster size.', 502);
      }
      chunks.push(chunk.data);
    } else if (chunk.type === 'IEND') {
      if (!sawData || chunk.length !== 0) {
        fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has an invalid IEND chunk.', 502);
      }
      sawEnd = true;
      if (offset !== png.length) {
        fail('INVALID_RENDER_OUTPUT', 'Rendered PNG has data after IEND.', 502);
      }
      break;
    } else {
      if ((chunk.typeBytes[0] & 32) === 0) {
        fail('UNSUPPORTED_RENDER_PNG', `Rendered PNG uses unsupported critical chunk ${chunk.type}.`, 422);
      }
      if (sawData) dataEnded = true;
    }
  }
  if (!sawHeader || !sawData || !sawEnd) {
    fail('INVALID_RENDER_OUTPUT', 'Rendered PNG is missing a required chunk.', 502);
  }
  return { chunks, colorType, expectedRawLength, height, idatLength, width };
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
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) row[x] = (row[x] + a) & 255;
      else if (filter === 2) row[x] = (row[x] + b) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((a + b) / 2)) & 255;
      else if (filter === 4) row[x] = (row[x] + paeth(a, b, c)) & 255;
      else if (filter !== 0) {
        fail('INVALID_RENDER_OUTPUT', 'Rendered PNG uses an invalid filter.', 502);
      }
    }
    for (let x = 0; x < width; x += 1) {
      pixels[destination++] = row[x * channels];
      pixels[destination++] = row[x * channels + 1];
      pixels[destination++] = row[x * channels + 2];
      pixels[destination++] = channels === 4 ? row[x * channels + 3] : 255;
    }
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

export function encodeRgbaPng({ width, height, pixels }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > MAX_PNG_EDGE || height > MAX_PNG_EDGE
    || width > Math.floor(MAX_PNG_PIXELS / height)
    || !Buffer.isBuffer(pixels) || pixels.length !== width * height * 4) {
    fail(
      'INVALID_PNG_PIXELS',
      'RGBA PNG input must contain bounded dimensions and exactly four bytes per pixel.',
    );
  }
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
