import { types as nodeTypes } from 'node:util';

export function sourceTransaction(source) {
  return Object.freeze({ kind: 'source', id: source.id, sha256: source.sha256, size: source.size,
    sourceId: source.id, sourceSha256: source.sha256 });
}

/** Compare only dense, data-only JSON-shaped values against a known request. */
export function sameSubmissionData(value, expected) {
  if (value === expected) return true;
  if (!value || !expected || typeof value !== 'object' || typeof expected !== 'object'
    || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.getPrototypeOf(expected)) return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(value) || value.length !== expected.length) return false;
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return false; }
    const keys = Reflect.ownKeys(value);
    return keys.length === value.length + 1 && keys.every((key) => key === 'length'
      || (typeof key === 'string' && /^\d+$/u.test(key) && Number(key) < value.length
        && Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')
        && descriptors[key].enumerable === true))
      && expected.every((entry, index) => sameSubmissionData(descriptors[String(index)].value, entry));
  }
  const expectedKeys = Reflect.ownKeys(expected); let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return false; }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key)
    || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) return false;
  return expectedKeys.every((key) => sameSubmissionData(descriptors[key].value, expected[key]));
}
