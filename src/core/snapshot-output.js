const REGION_KEYS = Object.freeze(['x', 'y', 'width', 'height']);
export const MAX_SNAPSHOT_BLOB_BYTES = 16 * 1024 * 1024;

function exactPlainObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

/**
 * Validate the public snapshot region contract. Coordinates are normalized to
 * the rendered CropBox image and use a top-left origin, not PDF user space.
 */
export function normalizeSnapshotRegion(region) {
  if (!exactPlainObject(region, REGION_KEYS)) {
    throw new TypeError('Snapshot region must contain only x, y, width, and height.');
  }
  const normalized = Object.fromEntries(REGION_KEYS.map((key) => [key, region[key]]));
  if (Object.values(normalized).some((value) => typeof value !== 'number' || !Number.isFinite(value)
    || Number(value.toFixed(6)) !== value)) {
    throw new TypeError('Snapshot coordinates must be finite numbers with at most six decimal places.');
  }
  if (normalized.x < 0 || normalized.y < 0 || normalized.x >= 1 || normalized.y >= 1
    || normalized.width <= 0 || normalized.height <= 0
    || normalized.x + normalized.width > 1 || normalized.y + normalized.height > 1) {
    throw new TypeError('Snapshot region must be a positive rectangle inside the normalized page raster.');
  }
  return Object.freeze(normalized);
}

function checkedPngBlob(blob) {
  if (!(blob instanceof Blob) || blob.type !== 'image/png'
    || !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > MAX_SNAPSHOT_BLOB_BYTES) {
    throw new TypeError('Snapshot output must be a non-empty bounded PNG Blob.');
  }
  return blob;
}

function staleSnapshotError() {
  const error = new Error('The snapshot request is no longer current.');
  error.code = 'SNAPSHOT_STALE';
  return error;
}

export async function prepareSnapshotPng(blobOrPromise, { isCurrent, decodeBlob } = {}) {
  if (typeof isCurrent !== 'function' || typeof decodeBlob !== 'function') {
    throw new TypeError('Snapshot preparation requires current-state and PNG decode handlers.');
  }
  if (!isCurrent()) throw staleSnapshotError();
  const blob = checkedPngBlob(await blobOrPromise);
  if (!isCurrent()) throw staleSnapshotError();
  await decodeBlob(blob);
  if (!isCurrent()) throw staleSnapshotError();
  return blob;
}

export async function copyPngToClipboard(blobOrPromise, {
  clipboard = globalThis.navigator?.clipboard,
  ClipboardItemCtor = globalThis.ClipboardItem,
} = {}) {
  if (!clipboard || typeof clipboard.write !== 'function' || typeof ClipboardItemCtor !== 'function') {
    throw new Error('PNG clipboard writing is unavailable in this browser. Use Download PNG instead.');
  }
  const verifiedBlob = Promise.resolve(blobOrPromise).then(checkedPngBlob);
  verifiedBlob.catch(() => {});
  const item = new ClipboardItemCtor({ 'image/png': verifiedBlob });
  await clipboard.write([item]);
  const blob = await verifiedBlob;
  return Object.freeze({ copied: true, mediaType: 'image/png', size: blob.size });
}
