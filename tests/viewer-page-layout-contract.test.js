import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CONTINUOUS_LAYOUT_PAGES,
  VIEWER_PAGE_LAYOUTS,
  nextViewerPageLayout,
  normalizeViewerPageLayout,
  resolveViewerPageLayout,
} from '../src/core/viewer-page-layout.js';

test('exports the exact frozen layout vocabulary and continuous bound', () => {
  assert.deepEqual(VIEWER_PAGE_LAYOUTS, ['single', 'continuous', 'facing', 'cover-facing']);
  assert.equal(Object.isFrozen(VIEWER_PAGE_LAYOUTS), true);
  assert.equal(MAX_CONTINUOUS_LAYOUT_PAGES, 32);
});

test('normalizes every supported layout and rejects non-strings or unsupported values', () => {
  for (const layout of VIEWER_PAGE_LAYOUTS) assert.equal(normalizeViewerPageLayout(layout), layout);
  for (const value of [undefined, null, 1, {}, [], new String('single')]) {
    assert.throws(() => normalizeViewerPageLayout(value), TypeError);
  }
  for (const value of ['', 'Single', 'two-up', 'cover-page', 'single ']) {
    assert.throws(() => normalizeViewerPageLayout(value), RangeError);
  }
});

test('cycles layouts in the declared order', () => {
  assert.deepEqual(
    VIEWER_PAGE_LAYOUTS.map((layout) => nextViewerPageLayout(layout)),
    ['continuous', 'facing', 'cover-facing', 'single'],
  );
  assert.throws(() => nextViewerPageLayout('two-up'), RangeError);
});

test('resolves single and bounded continuous pages', () => {
  assert.deepEqual(resolveViewerPageLayout({ layout: 'single', selectedPage: 7, pageCount: 9 }), {
    layout: 'single', pages: [7], truncated: false,
  });
  assert.deepEqual(resolveViewerPageLayout({ layout: 'continuous', selectedPage: 1, pageCount: 3 }), {
    layout: 'continuous', pages: [1, 2, 3], truncated: false,
  });
  const truncated = resolveViewerPageLayout({ layout: 'continuous', selectedPage: 32, pageCount: 33 });
  assert.deepEqual(truncated.pages, Array.from({ length: 32 }, (_, index) => index + 1));
  assert.equal(truncated.truncated, true);
});

test('resolves facing and cover-facing pairs at page boundaries', () => {
  assert.deepEqual(resolveViewerPageLayout({ layout: 'facing', selectedPage: 1, pageCount: 5 }).pages, [1, 2]);
  assert.deepEqual(resolveViewerPageLayout({ layout: 'facing', selectedPage: 2, pageCount: 5 }).pages, [1, 2]);
  assert.deepEqual(resolveViewerPageLayout({ layout: 'facing', selectedPage: 5, pageCount: 5 }).pages, [5]);
  assert.deepEqual(resolveViewerPageLayout({ layout: 'cover-facing', selectedPage: 1, pageCount: 5 }).pages, [1]);
  assert.deepEqual(resolveViewerPageLayout({ layout: 'cover-facing', selectedPage: 2, pageCount: 5 }).pages, [2, 3]);
  assert.deepEqual(resolveViewerPageLayout({ layout: 'cover-facing', selectedPage: 5, pageCount: 5 }).pages, [4, 5]);
  assert.deepEqual(resolveViewerPageLayout({ layout: 'cover-facing', selectedPage: 2, pageCount: 2 }).pages, [2]);
});

test('requires an exact plain data object with valid page bounds', () => {
  const valid = { layout: 'single', selectedPage: 1, pageCount: 1 };
  assert.equal(Object.getPrototypeOf(resolveViewerPageLayout(valid)), Object.prototype);
  for (const value of [
    null,
    [],
    { layout: 'single', selectedPage: 1 },
    { layout: 'single', selectedPage: 1, pageCount: 1, extra: true },
    Object.assign(Object.create({ inherited: true }), valid),
    Object.assign(Object.create(null), valid),
    { layout: 'single', selectedPage: 1, pageCount: 1, ['__proto__']: true },
  ]) assert.throws(() => resolveViewerPageLayout(value), TypeError);

  assert.throws(() => resolveViewerPageLayout(new Proxy(valid, {
    getPrototypeOf() { throw new Error('hostile prototype probe'); },
  })), TypeError);
  assert.throws(() => resolveViewerPageLayout(new Proxy(valid, {
    ownKeys() { return ['layout', 'selectedPage', 'pageCount', Symbol('unexpected')]; },
  })), TypeError);

  const accessor = {};
  Object.defineProperties(accessor, {
    layout: { get: () => 'single', enumerable: true },
    selectedPage: { value: 1, enumerable: true },
    pageCount: { value: 1, enumerable: true },
  });
  assert.throws(() => resolveViewerPageLayout(accessor), TypeError);

  for (const request of [
    { layout: 'single', selectedPage: 0, pageCount: 1 },
    { layout: 'single', selectedPage: 2, pageCount: 1 },
    { layout: 'single', selectedPage: 1.5, pageCount: 2 },
    { layout: 'single', selectedPage: 1, pageCount: 0 },
    { layout: 'single', selectedPage: 1, pageCount: 10_001 },
    { layout: 'single', selectedPage: 1, pageCount: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => resolveViewerPageLayout(request), RangeError);
});

test('does not mutate inputs or expose mutable results', () => {
  const request = Object.freeze({ layout: 'continuous', selectedPage: 2, pageCount: 3 });
  const result = resolveViewerPageLayout(request);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.pages), true);
  assert.deepEqual(request, { layout: 'continuous', selectedPage: 2, pageCount: 3 });
  assert.throws(() => result.pages.push(4), TypeError);
  assert.throws(() => { result.layout = 'single'; }, TypeError);
  assert.deepEqual(result, { layout: 'continuous', pages: [1, 2, 3], truncated: false });
});
