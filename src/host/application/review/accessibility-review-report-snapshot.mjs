import { isProxy } from 'node:util/types';

export const MAX_ACCESSIBILITY_REVIEW_BYTES = 128 * 1024;
const MAX_SNAPSHOT_ITEMS = 20_000;
const MAX_SNAPSHOT_DEPTH = 16;
const NOT_SNAPSHOT_SCALAR = Symbol('not-snapshot-scalar');

function consumeSnapshotBudget(state, depth, fail) {
  state.items += 1;
  if (state.items > MAX_SNAPSHOT_ITEMS || depth > MAX_SNAPSHOT_DEPTH) {
    fail('The accessibility review exceeds its structural limits.');
  }
}

function snapshotScalar(value, fail) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_ACCESSIBILITY_REVIEW_BYTES) fail('The accessibility review contains oversized text.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('The accessibility review contains a non-finite number.');
    return value;
  }
  return NOT_SNAPSHOT_SCALAR;
}

function admitSnapshotContainer(value, state, fail) {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    fail('The accessibility review must be acyclic plain JSON data.');
  }
  if (state.active.has(value)) fail('The accessibility review must be acyclic plain JSON data.');
  state.active.add(value);
}

function hasEnumerableSnapshotData(descriptors, key) {
  return Object.hasOwn(descriptors, key) && 'value' in descriptors[key]
    && descriptors[key].enumerable === true;
}

function copyDenseSnapshotArray(value, descriptors, keys, state, depth, fail) {
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_SNAPSHOT_ITEMS) {
    fail('The accessibility review contains an invalid array.');
  }
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  const actual = keys.filter((key) => key !== 'length');
  if (actual.length !== expected.length || actual.some((key) => typeof key !== 'string')
    || expected.some((key) => !hasEnumerableSnapshotData(descriptors, key))) {
    fail('The accessibility review requires dense data-only arrays.');
  }
  return expected.map((key) => snapshotAccessibilityReview(descriptors[key].value, fail, state, depth + 1));
}

function copyPlainSnapshotObject(value, descriptors, keys, state, depth, fail) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('The accessibility review contains a non-plain object.');
  }
  if (keys.some((key) => typeof key !== 'string' || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) {
    fail('The accessibility review requires data properties only.');
  }
  const result = Object.create(null);
  for (const key of keys) result[key] = snapshotAccessibilityReview(descriptors[key].value, fail, state, depth + 1);
  return result;
}

/** Snapshots untrusted review data without evaluating accessors or inherited hooks. */
export function snapshotAccessibilityReview(value, fail, state = { active: new Set(), items: 0 }, depth = 0) {
  consumeSnapshotBudget(state, depth, fail);
  const scalar = snapshotScalar(value, fail);
  if (scalar !== NOT_SNAPSHOT_SCALAR) return scalar;
  admitSnapshotContainer(value, state, fail);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const result = Array.isArray(value)
    ? copyDenseSnapshotArray(value, descriptors, keys, state, depth, fail)
    : copyPlainSnapshotObject(value, descriptors, keys, state, depth, fail);
  state.active.delete(value);
  return result;
}
