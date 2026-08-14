import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INCREMENTAL_PAGE_VECTOR_PROFILE,
  normalizeIncrementalPageVector,
} from '../scripts/host/pdf-page-vector-contract.mjs';

function request(overrides = {}) {
  return {
    profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
    page: 1,
    rect: { x: 10, y: 20, width: 30, height: 40 },
    ...overrides,
  };
}

function assertInvalid(value) {
  assert.throws(() => normalizeIncrementalPageVector(value), (error) => {
    assert.equal(error.code, 'INVALID_INCREMENTAL_PAGE_VECTOR');
    assert.equal(error.message, 'Incremental PDF page-vector request is invalid.');
    assert.equal(error.status, undefined);
    return true;
  });
}

test('normalizes a detached frozen page-vector request with the fixed profile', () => {
  const input = request();
  const normalized = normalizeIncrementalPageVector(input);
  assert.deepEqual(normalized, {
    profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
    page: 1,
    rect: { x: 10, y: 20, width: 30, height: 40 },
  });
  assert.notStrictEqual(normalized, input);
  assert.notStrictEqual(normalized.rect, input.rect);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.rect), true);
  input.rect.x = 99;
  assert.equal(normalized.rect.x, 10);
});

test('accepts the inclusive coordinate boundary and rejects invalid geometry', () => {
  assert.deepEqual(normalizeIncrementalPageVector(request({
    page: 100,
    rect: { x: -1_000_000, y: 1_000_000, width: 1_000_000, height: 1_000_000 },
  })).rect, { x: -1_000_000, y: 1_000_000, width: 1_000_000, height: 1_000_000 });

  [
    request({ page: 0 }),
    request({ page: 101 }),
    request({ rect: { x: 1_000_001, y: 0, width: 1, height: 1 } }),
    request({ rect: { x: 0, y: 0, width: 0, height: 1 } }),
    request({ rect: { x: 0, y: 0, width: 1, height: -1 } }),
  ].forEach(assertInvalid);
});

test('accepts exact request keys independently of their insertion order', () => {
  const reordered = {
    rect: { height: 40, width: 30, y: 20, x: 10 },
    page: 1,
    profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
  };

  assert.deepEqual(normalizeIncrementalPageVector(reordered), request());
});

test('rejects proxies and non-plain, accessor, non-enumerable, symbol, or extra request data', () => {
  let getterCalls = 0;
  const accessor = request();
  Object.defineProperty(accessor, 'profile', { enumerable: true, get() { getterCalls += 1; throw new Error('must not run'); } });
  const nestedAccessor = request();
  Object.defineProperty(nestedAccessor.rect, 'x', { enumerable: true, get() { getterCalls += 1; throw new Error('must not run'); } });
  const nonEnumerable = request();
  Object.defineProperty(nonEnumerable, 'profile', { enumerable: false });
  const symbol = request();
  symbol[Symbol('unexpected')] = true;
  const extra = request({ unexpected: true });
  const inherited = Object.assign(Object.create({}), request());
  const hostileProxy = new Proxy(request(), {
    get() { throw new Error('get trap must not run'); },
    getPrototypeOf() { throw new Error('prototype trap must not run'); },
    ownKeys() { throw new Error('ownKeys trap must not run'); },
    getOwnPropertyDescriptor() { throw new Error('descriptor trap must not run'); },
  });
  const revocable = Proxy.revocable(request(), {});
  revocable.revoke();

  [
    accessor,
    nestedAccessor,
    nonEnumerable,
    symbol,
    extra,
    inherited,
    hostileProxy,
    revocable.proxy,
  ].forEach(assertInvalid);
  assert.equal(getterCalls, 0);
});
