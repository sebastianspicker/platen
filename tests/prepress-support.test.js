import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPng,
  configuredLimits,
  DEFAULT_PREPRESS_LIMITS,
  publicImage,
} from '../scripts/host/prepress/prepress-support.mjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function uint32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, 'ascii');
  return Buffer.concat([uint32(data.length), typeBytes, data, uint32(crc32(Buffer.concat([typeBytes, data])))]);
}
function ihdr({ width = 1, height = 1, bitDepth = 8, colorType = 6, compression = 0, filter = 0, interlace = 0 } = {}) {
  return pngChunk('IHDR', Buffer.concat([uint32(width), uint32(height), Buffer.from([bitDepth, colorType, compression, filter, interlace])]));
}
function png(chunks) { return Buffer.concat([PNG_SIGNATURE, ...chunks]); }
function validPng() { return png([ihdr(), pngChunk('IDAT', Buffer.from([0])), pngChunk('IEND')]); }
function assertHostError(callback, code, message, status) { assert.throws(callback, { code, message, status }); }

test('assertPng accepts a CRC-valid, bounded PNG and publicImage returns immutable data', () => {
  const bytes = validPng();
  assert.doesNotThrow(() => assertPng(bytes));
  assert.doesNotThrow(() => assertPng(png([ihdr(), pngChunk('tEXt'), pngChunk('IDAT'), pngChunk('tEXt'), pngChunk('IDAT'), pngChunk('IEND')])));
  for (const [colorType, bitDepths] of [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]) {
    for (const bitDepth of bitDepths) assert.doesNotThrow(() => assertPng(png([ihdr({ bitDepth, colorType, interlace: 1 }), pngChunk('IDAT'), pngChunk('IEND')])));
  }
  const image = publicImage(bytes, 'preview.png', DEFAULT_PREPRESS_LIMITS);
  assert.equal(Object.isFrozen(image), true);
  assert.equal(image.format, 'image/png');
  assert.equal(image.data, bytes.toString('base64'));
});

test('assertPng retains CRC and truncation failures', () => {
  const corrupt = Buffer.from(validPng());
  corrupt[41] ^= 1;
  assertHostError(() => assertPng(corrupt), 'INVALID_ENGINE_OUTPUT', 'Prepress PNG is invalid.', 502);
  assertHostError(() => assertPng(validPng().subarray(0, -1)), 'INVALID_ENGINE_OUTPUT', 'Prepress PNG is truncated.', 502);
});

test('assertPng retains IHDR ordering, dimension, and encoding validation', () => {
  assertHostError(() => assertPng(png([pngChunk('tEXt'), ihdr(), pngChunk('IDAT'), pngChunk('IEND')])), 'INVALID_ENGINE_OUTPUT', 'Prepress PNG header must be the first chunk.', 502);
  assertHostError(() => assertPng(png([ihdr({ width: 0 }), pngChunk('IDAT'), pngChunk('IEND')])), 'PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
  assertHostError(() => assertPng(png([ihdr({ width: 2 }), pngChunk('IDAT'), pngChunk('IEND')]), { ...DEFAULT_PREPRESS_LIMITS, maxRasterDimension: 1 }), 'PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
  assertHostError(() => assertPng(png([ihdr({ bitDepth: 16, colorType: 3 }), pngChunk('IDAT'), pngChunk('IEND')])), 'INVALID_ENGINE_OUTPUT', 'Prepress PNG header uses unsupported encoding.', 502);
});

test('assertPng retains IDAT and IEND lifecycle validation', () => {
  const padding = pngChunk('tEXt', Buffer.alloc(12));
  assertHostError(() => assertPng(png([ihdr(), padding, pngChunk('IEND')])), 'INVALID_ENGINE_OUTPUT', 'Prepress PNG end marker is invalid.', 502);
  assertHostError(() => assertPng(png([ihdr(), pngChunk('IDAT'), pngChunk('IEND'), pngChunk('tEXt')])), 'INVALID_ENGINE_OUTPUT', 'Prepress PNG end marker is invalid.', 502);
  assertHostError(() => assertPng(png([ihdr(), pngChunk('IDAT'), padding])), 'INVALID_ENGINE_OUTPUT', 'Prepress PNG is incomplete.', 502);
});

test('configuredLimits accepts immutable valid overrides and rejects invalid policy inputs', () => {
  const limits = configuredLimits({ minDpi: 24, maxDpi: 144, maxPreviewBytes: 2, maxTotalPreviewBytes: 3 });
  assert.equal(Object.isFrozen(limits), true);
  assert.deepEqual(limits, { ...DEFAULT_PREPRESS_LIMITS, minDpi: 24, maxDpi: 144, maxPreviewBytes: 2, maxTotalPreviewBytes: 3 });
  for (const value of [{ unknown: 1 }, { minDpi: 0 }, { maxDpi: 300.5 }, { maxDpi: 301 }]) {
    assertHostError(() => configuredLimits(value), 'INVALID_LIMITS', 'Prepress limits must be positive integers within production hard maxima.', 400);
  }
  for (const value of [{ minDpi: 36, maxDpi: 35 }, { maxPreviewBytes: 2, maxTotalPreviewBytes: 1 }, { maxSeparationSourceBytes: 2, maxTotalSeparationSourceBytes: 1 }, { maxSeparationSourceBytes: 1, maxTotalSeparationSourceBytes: 2, maxWorkspaceBytes: 1 }]) {
    assertHostError(() => configuredLimits(value), 'INVALID_LIMITS', 'Prepress limits contain inconsistent relationships.', 400);
  }
});
