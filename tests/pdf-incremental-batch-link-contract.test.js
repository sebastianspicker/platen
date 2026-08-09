import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIncrementalBatchGoToLinks } from '../scripts/host/pdf-incremental-batch-link-contract.mjs';

const PROFILE = 'local-aec-batch-link-v1';

function link(overrides = {}) {
  return {
    sourcePage: 1,
    targetPage: 2,
    rect: { left: 10, bottom: 20, right: 30, top: 40 },
    ...overrides,
  };
}

function request(records = [link()]) {
  return { profile: PROFILE, links: records };
}

function assertInvalid(value, message) {
  assert.throws(() => normalizeIncrementalBatchGoToLinks(value), {
    code: 'INVALID_INCREMENTAL_BATCH_LINK',
    message,
  });
}

test('normalizes valid records and freezes every returned layer', () => {
  const result = normalizeIncrementalBatchGoToLinks(request([
    link(),
    link({ sourcePage: 100, targetPage: 100, rect: { left: -1_000_000, bottom: -2, right: 3, top: 1_000_000 } }),
  ]));

  assert.deepEqual(result, {
    profile: PROFILE,
    links: [
      { sourcePage: 1, targetPage: 2, rect: { left: 10, bottom: 20, right: 30, top: 40 } },
      { sourcePage: 100, targetPage: 100, rect: { left: -1_000_000, bottom: -2, right: 3, top: 1_000_000 } },
    ],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.links), true);
  assert.equal(Object.isFrozen(result.links[0]), true);
  assert.equal(Object.isFrozen(result.links[0].rect), true);
});

test('enforces inclusive page bounds', () => {
  for (const field of ['sourcePage', 'targetPage']) {
    assertInvalid(request([link({ [field]: 0 })]), `links[0] is outside the bounded page or rectangle limits.`);
    assertInvalid(request([link({ [field]: 101 })]), `links[0] is outside the bounded page or rectangle limits.`);
  }
});

test('rejects reversed and equal rectangle edges', () => {
  const invalidRectangles = [
    { left: 30, bottom: 20, right: 30, top: 40 },
    { left: 10, bottom: 20, right: 5, top: 40 },
    { left: 10, bottom: 40, right: 30, top: 40 },
    { left: 10, bottom: 50, right: 30, top: 40 },
  ];
  for (const rect of invalidRectangles) {
    assertInvalid(request([link({ rect })]), `links[0] is outside the bounded page or rectangle limits.`);
  }
});

test('rejects hidden or non-enumerable keys at every exact-object boundary', () => {
  const hiddenRequestKey = request();
  Object.defineProperty(hiddenRequestKey, 'extra', { value: true });
  assertInvalid(hiddenRequestKey, 'batch-link request has unsupported or missing keys.');

  const hiddenLinkKey = request();
  Object.defineProperty(hiddenLinkKey.links[0], 'extra', { value: true });
  assertInvalid(hiddenLinkKey, 'links[0] has unsupported or missing keys.');

  const hiddenRectKey = request();
  Object.defineProperty(hiddenRectKey.links[0].rect, 'top', { value: 40, enumerable: false });
  assertInvalid(hiddenRectKey, 'links[0].rect has unsupported or missing keys.');
});

test('rejects non-plain and proxy-like inputs', () => {
  assertInvalid(new Date(), 'batch-link request must be an exact object.');

  const nullPrototype = Object.create(null);
  nullPrototype.profile = PROFILE;
  nullPrototype.links = [link()];
  assertInvalid(nullPrototype, 'batch-link request must be an exact object.');

  const alteredPrototype = new Proxy(request(), { getPrototypeOf: () => null });
  assertInvalid(alteredPrototype, 'batch-link request must be an exact object.');

  const alteredLinksPrototype = request([link()]);
  alteredLinksPrototype.links = new Proxy(alteredLinksPrototype.links, { getPrototypeOf: () => Object.prototype });
  assertInvalid(alteredLinksPrototype, 'links must contain 1 through 50 exact records.');
});

test('rejects overflow, nonfinite, and noninteger numeric values', () => {
  for (const value of [1_000_001, -1_000_001]) {
    assertInvalid(request([link({ rect: { left: value, bottom: 1, right: 2, top: 3 } })]), 'links[0] is outside the bounded page or rectangle limits.');
  }
  for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, Number.MAX_VALUE]) {
    assertInvalid(request([link({ rect: { left: value, bottom: 1, right: 2, top: 3 } })]), 'links[0].rect.left must be a safe integer.');
  }
  assertInvalid(request([link({ sourcePage: Number.MAX_SAFE_INTEGER + 1 })]), 'links[0].sourcePage must be a safe integer.');
  assertInvalid(request([link({ targetPage: 1.5 })]), 'links[0].targetPage must be a safe integer.');
});

test('rejects duplicate records by normalized values', () => {
  const first = link();
  const duplicate = { sourcePage: first.sourcePage, targetPage: first.targetPage, rect: { ...first.rect } };
  assertInvalid(request([first, duplicate]), 'Duplicate batch-link records are not allowed.');
});
