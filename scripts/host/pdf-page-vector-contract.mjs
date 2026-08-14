import { isProxy } from 'node:util/types';

export const INCREMENTAL_PAGE_VECTOR_PROFILE = 'local-incremental-page-vector-v1';

const MAX_COORDINATE = 1_000_000;

function invalid(message = 'Incremental PDF page-vector request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_INCREMENTAL_PAGE_VECTOR';
  return error;
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') throw invalid();
  if (isProxy(value) || Array.isArray(value)) throw invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  return value;
}

function exactDataObject(value, keys) {
  const object = plainObject(value);
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const ownKeys = Reflect.ownKeys(object);
  if (ownKeys.length !== keys.length) throw invalid();
  if (keys.some((key) => !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) throw invalid();
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  return descriptors;
}

function safeInteger(value) {
  if (!Number.isSafeInteger(value)) throw invalid();
  return value;
}

function normalizePage(value) {
  const page = safeInteger(value);
  if (page < 1 || page > 100) throw invalid();
  return page;
}

function normalizeRectangle(value) {
  const descriptors = exactDataObject(value, ['x', 'y', 'width', 'height']);
  const rectangle = Object.fromEntries(['x', 'y', 'width', 'height']
    .map((key) => [key, safeInteger(descriptors[key].value)]));
  const { x, y, width, height } = rectangle;
  if (Object.values(rectangle).some((coordinate) => Math.abs(coordinate) > MAX_COORDINATE)) throw invalid();
  if (width <= 0 || height <= 0) throw invalid();
  if (![x + width, y + height].every(Number.isSafeInteger)) throw invalid();
  return Object.freeze(rectangle);
}

export function normalizeIncrementalPageVector(value) {
  const request = exactDataObject(value, ['profile', 'page', 'rect']);
  if (request.profile.value !== INCREMENTAL_PAGE_VECTOR_PROFILE) throw invalid();
  const page = normalizePage(request.page.value);
  const rect = normalizeRectangle(request.rect.value);
  return Object.freeze({
    profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
    page,
    rect,
  });
}
