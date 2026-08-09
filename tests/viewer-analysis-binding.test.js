import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectViewerAnalysisBinding, isViewerAnalysisBound } from '../src/core/viewer-analysis-binding.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const SHA = 'a'.repeat(64);

function analysis(overrides = {}) {
  return {
    status: 'ready',
    documentId: ID,
    sha256: SHA,
    inspection: { pageCount: 2 },
    textPages: [{ page: 1, text: 'Alpha' }, { page: 2, text: '' }],
    ...overrides,
  };
}

test('accepts valid empty and nonempty text pages and freezes the result', () => {
  const value = analysis({ textPages: [] });
  const result = inspectViewerAnalysisBinding(value);
  assert.deepEqual(result, { ready: true, reason: null, documentId: ID, sourceSha256: SHA, pageCount: 2 });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(isViewerAnalysisBound(value), true);
  const nonempty = inspectViewerAnalysisBinding(analysis());
  assert.equal(nonempty.ready, true);
});

test('rejects loading and error states with stable status reason', () => {
  for (const status of ['loading', 'error']) {
    assert.deepEqual(inspectViewerAnalysisBinding(analysis({ status })), {
      ready: false, reason: 'status', documentId: null, sourceSha256: null, pageCount: null,
    });
  }
});

test('rejects forged identity values', () => {
  assert.equal(inspectViewerAnalysisBinding(analysis({ documentId: 'not-a-uuid' })).reason, 'identity');
  assert.equal(inspectViewerAnalysisBinding(analysis({ documentId: ID.toUpperCase() })).reason, 'identity');
  assert.equal(inspectViewerAnalysisBinding(analysis({ sha256: SHA.toUpperCase() })).reason, 'identity');
  assert.equal(inspectViewerAnalysisBinding(analysis({ sha256: 'b'.repeat(63) })).reason, 'identity');
});

test('rejects invalid page counts and text-page locations', () => {
  for (const pageCount of [0, 10_001, 1.5, '2']) {
    assert.equal(inspectViewerAnalysisBinding(analysis({ inspection: { pageCount } })).reason, 'page-count');
  }
  assert.equal(inspectViewerAnalysisBinding(analysis({ textPages: [{ page: 1, text: 'a' }, { page: 1, text: 'b' }] })).reason, 'text-pages');
  assert.equal(inspectViewerAnalysisBinding(analysis({ textPages: [{ page: 3, text: 'a' }] })).reason, 'text-pages');
  assert.equal(inspectViewerAnalysisBinding(analysis({ textPages: [{ page: 0, text: 'a' }] })).reason, 'text-pages');
});

test('rejects extra text record keys, accessors, arrays, null, proxies, and altered prototypes', () => {
  assert.equal(inspectViewerAnalysisBinding(analysis({ textPages: [{ page: 1, text: 'a', extra: true }] })).reason, 'text-pages');
  const accessor = { page: 1, text: 'a' };
  Object.defineProperty(accessor, 'text', { enumerable: true, get: () => 'a' });
  assert.equal(inspectViewerAnalysisBinding(analysis({ textPages: [accessor] })).reason, 'text-pages');
  assert.equal(inspectViewerAnalysisBinding(null).reason, 'invalid');
  assert.equal(inspectViewerAnalysisBinding([]).reason, 'invalid');
  assert.equal(inspectViewerAnalysisBinding(new Proxy(analysis(), {})).reason, 'invalid');
  assert.equal(inspectViewerAnalysisBinding(Object.create(null)).reason, 'invalid');
  assert.equal(inspectViewerAnalysisBinding(analysis({ inspection: new Proxy({ pageCount: 2 }, {}) })).reason, 'page-count');
  const altered = analysis();
  Object.setPrototypeOf(altered, { inherited: true });
  assert.equal(inspectViewerAnalysisBinding(altered).reason, 'invalid');
});

test('does not mutate input or nested values', () => {
  const value = analysis();
  const before = structuredClone(value);
  inspectViewerAnalysisBinding(value);
  assert.deepEqual(value, before);
});
