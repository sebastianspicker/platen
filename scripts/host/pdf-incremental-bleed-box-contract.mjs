export const INCREMENTAL_BLEED_BOX_PROFILE = 'local-classic-incremental-bleed-box-v1';
const MAX_COORDINATE = 1_000_000;

function invalid(message = 'Incremental PDF bleed-box request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_INCREMENTAL_BLEED_BOX';
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value')) || ownKeys.some((key) => typeof key !== 'string'
    || !keys.includes(key))) throw invalid();
  return descriptors;
}

function integer(value) {
  if (!Number.isSafeInteger(value)) throw invalid();
  return value;
}

export function normalizeIncrementalBleedBox(value) {
  const request = exactObject(value, ['profile', 'page', 'rect']);
  if (request.profile.value !== INCREMENTAL_BLEED_BOX_PROFILE) throw invalid();
  const page = integer(request.page.value);
  if (page < 1 || page > 100) throw invalid();
  const rectangle = exactObject(request.rect.value, ['x', 'y', 'width', 'height']);
  const x = integer(rectangle.x.value); const y = integer(rectangle.y.value);
  const width = integer(rectangle.width.value); const height = integer(rectangle.height.value);
  if ([x, y, width, height].some((entry) => Math.abs(entry) > MAX_COORDINATE)
    || width <= 0 || height <= 0
    || !Number.isSafeInteger(x + width) || !Number.isSafeInteger(y + height)) throw invalid();
  return Object.freeze({
    profile: INCREMENTAL_BLEED_BOX_PROFILE,
    page,
    rect: Object.freeze({ x, y, width, height }),
  });
}
