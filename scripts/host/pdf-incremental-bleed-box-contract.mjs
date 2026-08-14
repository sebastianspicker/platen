import { isProxy } from 'node:util/types';

export const INCREMENTAL_BLEED_BOX_PROFILE = 'local-classic-incremental-bleed-box-v1';
const MAX_COORDINATE = 1_000_000;

function invalid(message = 'Incremental PDF bleed-box request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_INCREMENTAL_BLEED_BOX';
  return error;
}

function plainObject(value) {
  if (!value) throw invalid();
  if (typeof value !== 'object') throw invalid();
  if (Array.isArray(value)) throw invalid();
  if (isProxy(value)) throw invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  return value;
}

function isAllowedKey(key, keys) {
  if (typeof key !== 'string') return false;
  return keys.includes(key);
}

function hasDataDescriptor(descriptors, key) {
  const descriptor = descriptors[key];
  if (!descriptor) return false;
  return Object.hasOwn(descriptor, 'value');
}

function exactObject(value, keys) {
  const object = plainObject(value);
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const ownKeys = Reflect.ownKeys(object);
  if (ownKeys.length !== keys.length) throw invalid();
  if (!ownKeys.every((key) => isAllowedKey(key, keys))) throw invalid();
  if (!keys.every((key) => hasDataDescriptor(descriptors, key))) throw invalid();
  return descriptors;
}

function integer(value) {
  if (!Number.isSafeInteger(value)) throw invalid();
  return value;
}

function pageNumber(value) {
  const page = integer(value);
  if (page < 1) throw invalid();
  if (page > 100) throw invalid();
  return page;
}

function boundedCoordinate(value) {
  if (Math.abs(value) > MAX_COORDINATE) throw invalid();
  return value;
}

function positiveSize(value) {
  if (value <= 0) throw invalid();
  return value;
}

function safeEnd(origin, size) {
  if (!Number.isSafeInteger(origin + size)) throw invalid();
}

function normalizeRectangle(value) {
  const rectangle = exactObject(value, ['x', 'y', 'width', 'height']);
  const x = boundedCoordinate(integer(rectangle.x.value));
  const y = boundedCoordinate(integer(rectangle.y.value));
  const width = positiveSize(boundedCoordinate(integer(rectangle.width.value)));
  const height = positiveSize(boundedCoordinate(integer(rectangle.height.value)));
  safeEnd(x, width);
  safeEnd(y, height);
  return Object.freeze({ x, y, width, height });
}

export function normalizeIncrementalBleedBox(value) {
  const request = exactObject(value, ['profile', 'page', 'rect']);
  if (request.profile.value !== INCREMENTAL_BLEED_BOX_PROFILE) throw invalid();
  const page = pageNumber(request.page.value);
  const rect = normalizeRectangle(request.rect.value);
  return Object.freeze({
    profile: INCREMENTAL_BLEED_BOX_PROFILE,
    page,
    rect,
  });
}
