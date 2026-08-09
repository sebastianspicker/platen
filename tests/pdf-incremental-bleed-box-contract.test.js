import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INCREMENTAL_BLEED_BOX_PROFILE,
  normalizeIncrementalBleedBox,
} from '../scripts/host/pdf-incremental-bleed-box-contract.mjs';

function request(overrides = {}) {
  return {
    profile: INCREMENTAL_BLEED_BOX_PROFILE,
    page: 1,
    rect: { x: -5, y: 10, width: 90, height: 80 },
    ...overrides,
  };
}

function invalid(value) {
  assert.throws(() => normalizeIncrementalBleedBox(value), (error) => (
    error.code === 'INVALID_INCREMENTAL_BLEED_BOX'
      && error.message === 'Incremental PDF bleed-box request is invalid.'
  ));
}

test('incremental bleed-box normalization preserves its exact canonical profile and frozen field order', () => {
  const input = request({ rect: { width: 90, y: 10, height: 80, x: -5 } });
  const result = normalizeIncrementalBleedBox(input);

  assert.deepEqual(result, request());
  assert.notStrictEqual(result, input);
  assert.notStrictEqual(result.rect, input.rect);
  assert.deepEqual(Object.keys(result), ['profile', 'page', 'rect']);
  assert.deepEqual(Object.keys(result.rect), ['x', 'y', 'width', 'height']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rect), true);
  assert.throws(() => { result.page = 2; }, TypeError);
  assert.throws(() => { result.rect.width = 1; }, TypeError);
});

test('incremental bleed-box normalization rejects non-canonical shapes and hostile records', () => {
  const accessor = request();
  let accessorRead = false;
  Object.defineProperty(accessor, 'page', {
    enumerable: true,
    get() { accessorRead = true; return 1; },
  });
  const nestedAccessor = request();
  Object.defineProperty(nestedAccessor.rect, 'x', { enumerable: true, get: () => -5 });
  const hiddenExtra = request();
  Object.defineProperty(hiddenExtra, 'extra', { value: true });

  for (const value of [
    null,
    [],
    Object.create(null),
    { profile: INCREMENTAL_BLEED_BOX_PROFILE, page: 1 },
    { ...request(), extra: true },
    { ...request(), sourceSha256: 'a'.repeat(64) },
    hiddenExtra,
    accessor,
    nestedAccessor,
    new Proxy(request(), { get() { throw new Error('proxy accessor ran'); } }),
    request({ rect: new Proxy(request().rect, { get() { throw new Error('proxy accessor ran'); } }) }),
  ]) invalid(value);

  assert.equal(accessorRead, false);
});

test('incremental bleed-box normalization enforces profile, page, coordinate, and size bounds', () => {
  for (const value of [
    request({ profile: 'other-profile' }),
    request({ page: 0 }),
    request({ page: 101 }),
    request({ page: 1.5 }),
    request({ page: Number.NaN }),
    request({ rect: { x: -1_000_001, y: 0, width: 1, height: 1 } }),
    request({ rect: { x: 1_000_001, y: 0, width: 1, height: 1 } }),
    request({ rect: { x: 0, y: 0, width: 0, height: 1 } }),
    request({ rect: { x: 0, y: 0, width: 1, height: 0 } }),
    request({ rect: { x: 0, y: 0, width: -1, height: 1 } }),
    request({ rect: { x: 0.5, y: 0, width: 1, height: 1 } }),
    request({ rect: { x: 0, y: 0, width: 1.5, height: 1 } }),
    request({ rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 } }),
  ]) invalid(value);

  assert.deepEqual(normalizeIncrementalBleedBox(request({
    page: 100,
    rect: { x: -1_000_000, y: 1_000_000, width: 1_000_000, height: 1_000_000 },
  })), {
    profile: INCREMENTAL_BLEED_BOX_PROFILE,
    page: 100,
    rect: { x: -1_000_000, y: 1_000_000, width: 1_000_000, height: 1_000_000 },
  });
});
