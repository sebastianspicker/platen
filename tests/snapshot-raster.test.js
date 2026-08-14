import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { decodePng, encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { cropPngRegion } from '../scripts/host/raster-snapshot.mjs';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const value = Buffer.alloc(12 + data.length); value.writeUInt32BE(data.length, 0); value.write(type, 4, 4, 'ascii'); data.copy(value, 8); value.writeUInt32BE(crc32(value.subarray(4, 8 + data.length)), 8 + data.length); return value;
}
function craftedPng({ width = 1, height = 1, compressed = deflateSync(Buffer.from([0, 0, 0, 0, 255])), between = [] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', header), ...between, chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}
function grid(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4; pixels[offset] = x; pixels[offset + 1] = y; pixels[offset + 2] = y * width + x; pixels[offset + 3] = 255;
  }
  return encodeRgbaPng({ width, height, pixels });
}

test('snapshot raster crops normalized top-left coordinates with floor and ceil pixel coverage', () => {
  const result = cropPngRegion(grid(4, 4), { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.pixelBounds), true);
  assert.equal(Buffer.isBuffer(result.png), true); assert.equal(result.width, 2); assert.equal(result.height, 2);
  assert.deepEqual(result.pixelBounds, { left: 1, top: 1, right: 3, bottom: 3 });
  assert.deepEqual(decodePng(result.png).pixels, Buffer.from([
    1, 1, 5, 255, 2, 1, 6, 255,
    1, 2, 9, 255, 2, 2, 10, 255,
  ]));

  const rounded = cropPngRegion(grid(4, 4), { x: 0.26, y: 0.01, width: 0.25, height: 0.25 });
  assert.deepEqual(rounded.pixelBounds, { left: 1, top: 0, right: 3, bottom: 2 });
  assert.deepEqual({ width: rounded.width, height: rounded.height }, { width: 2, height: 2 });

  const decimalExact = cropPngRegion(grid(100, 100), { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
  assert.deepEqual(decimalExact.pixelBounds, { left: 10, top: 10, right: 30, bottom: 30 });
  assert.deepEqual({ width: decimalExact.width, height: decimalExact.height }, { width: 20, height: 20 });
  const decimalBoundary = cropPngRegion(grid(100, 100), { x: 0.7, y: 0.7, width: 0.3, height: 0.3 });
  assert.deepEqual(decimalBoundary.pixelBounds, { left: 70, top: 70, right: 100, bottom: 100 });
});

test('snapshot raster rejects ambiguous regions and invalid hard limits before allocating output', () => {
  const source = grid(4, 4);
  for (const region of [
    { x: 0, y: 0, width: 1, height: 1, extra: true },
    { x: -0.1, y: 0, width: 0.5, height: 0.5 },
    { x: 0.8, y: 0, width: 0.3, height: 0.5 },
    { x: 0, y: 0, width: Number.NaN, height: 0.5 },
    { x: 0, y: 0, width: 0.1234567, height: 0.5 },
    { x: 1, y: 0, width: Number.MIN_VALUE, height: 0.5 },
    Object.assign(Object.create(null), { x: 0, y: 0, width: 1, height: 1 }),
  ]) assert.throws(() => cropPngRegion(source, region), { code: 'INVALID_SNAPSHOT_REGION', status: 400 });
  assert.throws(() => cropPngRegion(source, { x: 0, y: 0, width: 1, height: 1 }, 0), { code: 'INVALID_LIMITS', status: 400 });
  assert.throws(() => cropPngRegion(source, { x: 0, y: 0, width: 1, height: 1 }, 4), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
});

test('PNG codec writes and verifies CRCs and rejects truncated or trailing chunk bytes', () => {
  const valid = grid(2, 2); assert.deepEqual({ width: decodePng(valid).width, height: decodePng(valid).height }, { width: 2, height: 2 });
  assert.equal(encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.alloc(4) }).subarray(29, 33).toString('hex'), '1f15c489');
  const corrupted = Buffer.from(valid); corrupted[41] ^= 1;
  assert.throws(() => decodePng(corrupted), { code: 'INVALID_RENDER_OUTPUT', status: 502 });
  assert.throws(() => decodePng(valid.subarray(0, valid.length - 1)), { code: 'INVALID_RENDER_OUTPUT', status: 502 });
  assert.throws(() => decodePng(Buffer.concat([valid, Buffer.from([0])])), { code: 'INVALID_RENDER_OUTPUT', status: 502 });
  assert.throws(() => encodeRgbaPng({ width: 2, height: 2, pixels: Buffer.alloc(15) }), { code: 'INVALID_PNG_PIXELS', status: 400 });
  assert.throws(() => encodeRgbaPng({ width: 8_193, height: 1, pixels: Buffer.alloc(8_193 * 4) }), { code: 'INVALID_PNG_PIXELS', status: 400 });
});

test('PNG decoder bounds dimensions and inflation and enforces critical chunk structure', () => {
  assert.throws(() => decodePng(craftedPng({ width: 1_000, height: 1_000 }), 100), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
  assert.throws(() => decodePng(craftedPng({ width: 8_192, height: 1_013 })), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
  assert.throws(() => decodePng(craftedPng({ compressed: deflateSync(Buffer.alloc(100)) })), { code: 'INVALID_RENDER_OUTPUT', status: 502 });
  const oneStream = deflateSync(Buffer.from([0, 0, 0, 0, 255]));
  assert.throws(() => decodePng(craftedPng({ compressed: Buffer.concat([oneStream, Buffer.from('trailing')]) })), { code: 'INVALID_RENDER_OUTPUT', status: 502 });
  assert.throws(() => decodePng(craftedPng({ between: [chunk('ABCD', Buffer.alloc(0))] })), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
  assert.throws(() => decodePng(craftedPng({ between: [chunk('acTL', Buffer.alloc(8))] })), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
  assert.throws(() => decodePng(craftedPng({ between: [chunk('fcTL', Buffer.alloc(26))] })), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
  assert.throws(() => decodePng(craftedPng({ between: [chunk('fdAT', Buffer.alloc(4))] })), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
  assert.throws(() => decodePng(craftedPng({ between: [chunk('tRNS', Buffer.alloc(6))] })), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
  assert.throws(() => decodePng(craftedPng({ width: 8_193, height: 1 })), { code: 'UNSUPPORTED_RENDER_PNG', status: 422 });
  assert.throws(() => decodePng(Buffer.concat([signature, Buffer.alloc((16 * 1024 * 1024) - signature.length + 1)])), { code: 'RENDER_OUTPUT_LIMIT', status: 413 });
  assert.doesNotThrow(() => decodePng(craftedPng({ between: [chunk('tEXt', Buffer.from('source\0local'))] })));
});
