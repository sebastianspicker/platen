import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { HostError } from '../host-error.mjs';

export const DEFAULT_PREPRESS_LIMITS = Object.freeze({
  maxInkPages: 200, maxPreviewPage: 10_000, minDpi: 36, maxDpi: 300,
  maxRasterDimension: 8_192, maxRasterPixels: 32 * 1024 * 1024,
  maxSeparationSourceBytes: 96 * 1024 * 1024, maxTotalSeparationSourceBytes: 256 * 1024 * 1024,
  maxSeparationFiles: 8, maxPreviewBytes: 4 * 1024 * 1024, maxTotalPreviewBytes: 12 * 1024 * 1024,
  maxWorkspaceBytes: 320 * 1024 * 1024, maxWorkspaceFiles: 48, maxPreflightPages: 200,
  maxArtifactPages: 200, maxDerivedPdfBytes: 256 * 1024 * 1024, timeoutMs: 2 * 60_000,
});
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function fail(code, message, status = 400) { throw new HostError(code, message, status); }
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export async function digestFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export function cancelled(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'The local prepress operation was cancelled.', 499); }
function validConfiguredLimit(key, item, limits) { return key in limits && Number.isSafeInteger(item) && item >= 1 && item <= DEFAULT_PREPRESS_LIMITS[key]; }
function consistentLimitRelationships(limits) {
  return limits.minDpi <= limits.maxDpi
    && limits.maxPreviewBytes <= limits.maxTotalPreviewBytes
    && limits.maxSeparationSourceBytes <= limits.maxTotalSeparationSourceBytes
    && limits.maxTotalSeparationSourceBytes <= limits.maxWorkspaceBytes;
}
export function configuredLimits(value) {
  const result = { ...DEFAULT_PREPRESS_LIMITS };
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!validConfiguredLimit(key, item, result)) fail('INVALID_LIMITS', 'Prepress limits must be positive integers within production hard maxima.');
    result[key] = item;
  }
  if (!consistentLimitRelationships(result)) fail('INVALID_LIMITS', 'Prepress limits contain inconsistent relationships.');
  return Object.freeze(result);
}
export function page(value, maximum) { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('INVALID_PAGE', `page must be an integer from 1 through ${maximum}.`); return value; }
export function dpi(value, limits) { if (!Number.isSafeInteger(value) || value < limits.minDpi || value > limits.maxDpi) fail('INVALID_DPI', `dpi must be an integer from ${limits.minDpi} through ${limits.maxDpi}.`); return value; }
export function boundedRenderDpi(dimensions, requestedDpi, limits) {
  const { widthPoints, heightPoints } = dimensions ?? {};
  if (![widthPoints, heightPoints].every((value) => Number.isFinite(value) && value > 0)) fail('INVALID_ENGINE_OUTPUT', 'PDF inspection did not return valid page geometry.', 502);
  const dimensionDpi = Math.floor(Math.min(limits.maxRasterDimension * 72 / widthPoints, limits.maxRasterDimension * 72 / heightPoints));
  const pixelDpi = Math.floor(72 * Math.sqrt(limits.maxRasterPixels / (widthPoints * heightPoints)));
  const effectiveDpi = Math.min(requestedDpi, dimensionDpi, pixelDpi);
  if (effectiveDpi < limits.minDpi) fail('PREPRESS_PAGE_TOO_LARGE', 'This page cannot be rasterized within the local prepress pixel limits.', 422);
  return effectiveDpi;
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
const PNG_ALLOWED_BIT_DEPTHS = new Map([[0, new Set([1, 2, 4, 8, 16])], [2, new Set([8, 16])], [3, new Set([1, 2, 4, 8])], [4, new Set([8, 16])], [6, new Set([8, 16])]]);
function pngChunkFrame(bytes, offset) {
  if (offset + 12 > bytes.length) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG is truncated.', 502);
  const length = bytes.readUInt32BE(offset);
  const end = offset + 12 + length;
  if (end > bytes.length) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG is invalid.', 502);
  return { end, length, offset, type: bytes.toString('ascii', offset + 4, offset + 8) };
}
function assertPngChunkCrc(bytes, chunk) {
  if (bytes.readUInt32BE(chunk.end - 4) !== crc32(bytes.subarray(chunk.offset + 4, chunk.end - 4))) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG is invalid.', 502);
}
function assertPngIhdrPosition(chunk, headerSeen) {
  if (headerSeen) fail('PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
  if (chunk.offset !== 8) fail('PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
  if (chunk.length !== 13) fail('PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
}
function assertPngDimensions(width, height, limits) {
  if (!width) fail('PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
  if (!height) fail('PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
  if (width > limits.maxRasterDimension) fail('PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
  if (height > limits.maxRasterDimension) fail('PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
  if (width * height > limits.maxRasterPixels) fail('PREPRESS_OUTPUT_LIMIT', 'Prepress PNG dimensions exceed local limits.', 413);
}
function pngBitDepthSupported(colorType, bitDepth) { return PNG_ALLOWED_BIT_DEPTHS.get(colorType)?.has(bitDepth); }
function assertPngEncoding(bytes, chunk) {
  if (!pngBitDepthSupported(bytes[chunk.offset + 17], bytes[chunk.offset + 16])) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG header uses unsupported encoding.', 502);
  if (bytes[chunk.offset + 18]) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG header uses unsupported encoding.', 502);
  if (bytes[chunk.offset + 19]) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG header uses unsupported encoding.', 502);
  if (bytes[chunk.offset + 20] > 1) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG header uses unsupported encoding.', 502);
}
function validatePngIhdr(bytes, chunk, limits, headerSeen) {
  const width = bytes.readUInt32BE(chunk.offset + 8);
  const height = bytes.readUInt32BE(chunk.offset + 12);
  assertPngIhdrPosition(chunk, headerSeen);
  assertPngDimensions(width, height, limits);
  assertPngEncoding(bytes, chunk);
}
function pngLifecycle() { return { ended: false, header: false, imageData: false }; }
function assertPngIend(chunk, state, byteLength) {
  if (chunk.length) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG end marker is invalid.', 502);
  if (state.ended) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG end marker is invalid.', 502);
  if (!state.imageData) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG end marker is invalid.', 502);
  if (chunk.end !== byteLength) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG end marker is invalid.', 502);
}
function advancePngLifecycle(bytes, chunk, limits, state) {
  if (chunk.type === 'IHDR') {
    validatePngIhdr(bytes, chunk, limits, state.header);
    state.header = true;
  } else {
    if (!state.header) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG header must be the first chunk.', 502);
  }
  if (chunk.type === 'IDAT') state.imageData = true;
  if (chunk.type === 'IEND') {
    assertPngIend(chunk, state, bytes.length);
    state.ended = true;
  }
}
function assertCompletePng(state) { if (!state.header || !state.imageData || !state.ended) fail('INVALID_ENGINE_OUTPUT', 'Prepress PNG is incomplete.', 502); }
export function assertPng(bytes, limits = DEFAULT_PREPRESS_LIMITS) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail('INVALID_ENGINE_OUTPUT', 'Prepress engine did not produce a PNG image.', 502);
  let offset = 8;
  const state = pngLifecycle();
  while (offset < bytes.length) {
    const chunk = pngChunkFrame(bytes, offset);
    assertPngChunkCrc(bytes, chunk);
    advancePngLifecycle(bytes, chunk, limits, state);
    offset = chunk.end;
  }
  assertCompletePng(state);
}
export function publicImage(bytes, label, limits) { assertPng(bytes, limits); return Object.freeze({ label, format: 'image/png', encoding: 'base64', sha256: digest(bytes), data: bytes.toString('base64') }); }
export function evidence(operation, engine, limitations) { return Object.freeze({ localOnly: true, engine: Object.freeze({ name: engine, operation }), limitations: Object.freeze(limitations) }); }
export function normalizedText(value) { return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim(); }
export function recipeUuid(value) { const hex = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32).split(''); hex[12] = '5'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]; const compact = hex.join(''); return `uuid:${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`; }
export function deterministicDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function boxesMatch(left, right, tolerance = 0.01) { return left && right && ['left', 'bottom', 'right', 'top'].every((key) => Math.abs(left[key] - right[key]) <= tolerance); }
export function pageGeometryMatches(left, right, tolerance = 0.01) { return Math.abs(left.widthPoints - right.widthPoints) <= tolerance && Math.abs(left.heightPoints - right.heightPoints) <= tolerance && left.rotation === right.rotation && boxesMatch(left.boxes.mediaBox, right.boxes.mediaBox, tolerance) && boxesMatch(left.boxes.cropBox, right.boxes.cropBox, tolerance); }
export function parseInkCoverage(stdout, maxPages = DEFAULT_PREPRESS_LIMITS.maxInkPages) {
  if (typeof stdout !== 'string' || !stdout.trim()) fail('INK_COVERAGE_INVALID', 'Ghostscript did not emit ink coverage rows.', 502);
  const rows = stdout.trim().split(/\r?\n/u).filter((line) => !/^(?:GPL Ghostscript |Copyright \(C\)|This software is supplied |see the file |Processing pages \d+ through \d+[.]$|Page \d+$|Loading font )/u.test(line));
  if (!rows.length) fail('INK_COVERAGE_INVALID', 'Ghostscript did not emit ink coverage rows.', 502); if (rows.length > maxPages) fail('INK_COVERAGE_LIMIT', `Ink coverage is limited to ${maxPages} pages.`, 422);
  return Object.freeze(rows.map((line, index) => { const match = /^\s*(0(?:\.\d+)?|1(?:\.0+)?)\s+(0(?:\.\d+)?|1(?:\.0+)?)\s+(0(?:\.\d+)?|1(?:\.0+)?)\s+(0(?:\.\d+)?|1(?:\.0+)?)\s+CMYK\s+OK\s*$/u.exec(line); if (!match) fail('INK_COVERAGE_INVALID', `Ink coverage row ${index + 1} is invalid.`, 502); const [cyan, magenta, yellow, black] = match.slice(1).map(Number); return Object.freeze({ page: index + 1, cyan, magenta, yellow, black, totalInkPercent: (cyan + magenta + yellow + black) * 100 }); }));
}
