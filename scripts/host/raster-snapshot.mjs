import { HostError } from './host-error.mjs';
import { decodePng, encodeRgbaPng, MAX_PNG_PIXELS } from './raster-png-codec.mjs';

const DEFAULT_SNAPSHOT_MAX_PIXELS = 8_294_400;
const MAX_SNAPSHOT_OUTPUT_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_DECIMAL_SCALE = 1_000_000;

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function normalizeSnapshotRegion(region) {
  if (!region || typeof region !== 'object' || Array.isArray(region)
    || Object.getPrototypeOf(region) !== Object.prototype
    || Object.keys(region).sort().join(',') !== 'height,width,x,y') {
    fail(
      'INVALID_SNAPSHOT_REGION',
      'Snapshot region must contain only x, y, width, and height.',
    );
  }
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(
    (value) => Number.isFinite(value) && Number(value.toFixed(6)) === value,
  )) {
    fail(
      'INVALID_SNAPSHOT_REGION',
      'Snapshot coordinates must be finite numbers with at most six decimal places.',
    );
  }
  const units = Object.fromEntries(Object.entries({ x, y, width, height })
    .map(([key, value]) => [key, Math.round(value * SNAPSHOT_DECIMAL_SCALE)]));
  if (units.x < 0 || units.y < 0 || units.width <= 0 || units.height <= 0
    || units.x + units.width > SNAPSHOT_DECIMAL_SCALE
    || units.y + units.height > SNAPSHOT_DECIMAL_SCALE) {
    fail(
      'INVALID_SNAPSHOT_REGION',
      'Snapshot region must be a positive normalized rectangle inside the rendered page.',
    );
  }
  return units;
}

export function cropPngRegion(png, region, maximumPixels = DEFAULT_SNAPSHOT_MAX_PIXELS) {
  if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1
    || maximumPixels > MAX_PNG_PIXELS) {
    fail(
      'INVALID_LIMITS',
      `Snapshot pixel limits must be integers from 1 through ${MAX_PNG_PIXELS}.`,
    );
  }
  const normalized = normalizeSnapshotRegion(region);
  const source = decodePng(png, maximumPixels);
  const left = Math.floor((normalized.x * source.width) / SNAPSHOT_DECIMAL_SCALE);
  const top = Math.floor((normalized.y * source.height) / SNAPSHOT_DECIMAL_SCALE);
  const right = Math.ceil(
    ((normalized.x + normalized.width) * source.width) / SNAPSHOT_DECIMAL_SCALE,
  );
  const bottom = Math.ceil(
    ((normalized.y + normalized.height) * source.height) / SNAPSHOT_DECIMAL_SCALE,
  );
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1 || width > Math.floor(maximumPixels / height)) {
    fail('SNAPSHOT_RASTER_LIMIT', 'Snapshot region exceeds the local output pixel limit.', 413);
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = (((top + row) * source.width) + left) * 4;
    source.pixels.copy(pixels, row * width * 4, sourceStart, sourceStart + width * 4);
  }
  const output = encodeRgbaPng({ width, height, pixels });
  if (output.length > MAX_SNAPSHOT_OUTPUT_BYTES) {
    fail('SNAPSHOT_RASTER_LIMIT', 'Snapshot PNG exceeds the local output byte limit.', 413);
  }
  return Object.freeze({
    png: output,
    width,
    height,
    pixelBounds: Object.freeze({ left, top, right, bottom }),
  });
}
