import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveViewerGridVisibility, isViewerDocumentBound } from '../src/core/viewer-grid-overlay.js';

const boundAnalysis = Object.freeze({
  status: 'ready',
  documentId: '123e4567-e89b-42d3-a456-426614174000',
  sha256: 'a'.repeat(64),
  inspection: Object.freeze({ pageCount: 1 }),
  textPages: Object.freeze([]),
});

function document(overrides = {}) {
  return {
    isOpen: true,
    objectUrl: 'blob:document-1',
    name: 'source.pdf',
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    requested: true,
    document: document(),
    analysis: boundAnalysis,
    ...overrides,
  };
}

test('derives visible for a requested open blob-bound ready analysis', () => {
  assert.equal(deriveViewerGridVisibility(input()), true);
  assert.equal(isViewerDocumentBound(document()), true);
});

test('derives unavailable for loading, error, and missing analysis states', () => {
  for (const analysis of [
    { status: 'loading' },
    { status: 'error', error: 'analysis failed' },
    null,
    undefined,
  ]) {
    assert.equal(deriveViewerGridVisibility(input({ analysis })), false);
  }
});

test('derives unavailable when closed, not requested, or using a forged blob identity', () => {
  assert.equal(deriveViewerGridVisibility(input({ requested: false })), false);
  assert.equal(deriveViewerGridVisibility(input({ document: document({ isOpen: false, objectUrl: null }) })), false);
  assert.equal(deriveViewerGridVisibility(input({ document: document({ objectUrl: 'blob:forged' }), analysis: { status: 'ready' } })), false);
  assert.throws(() => deriveViewerGridVisibility(input({ document: document({ objectUrl: 'https://forged.example/source.pdf' }) })), TypeError);
});

test('rejects malformed, accessor-backed, inherited, and unknown-key inputs', () => {
  assert.throws(() => deriveViewerGridVisibility([]), TypeError);
  assert.throws(() => deriveViewerGridVisibility(new Proxy(input(), {})), TypeError);
  assert.throws(() => deriveViewerGridVisibility({ ...input(), extra: true }), TypeError);
  assert.throws(() => deriveViewerGridVisibility(Object.create({ requested: true })), TypeError);
  const accessorInput = input();
  Object.defineProperty(accessorInput, 'requested', { get: () => true, enumerable: true });
  assert.throws(() => deriveViewerGridVisibility(accessorInput), TypeError);
  assert.throws(() => deriveViewerGridVisibility(input({ requested: 'true' })), TypeError);
  assert.throws(() => deriveViewerGridVisibility(input({ document: Object.create(document()) })), TypeError);
  assert.throws(() => deriveViewerGridVisibility(input({ document: new Proxy(document(), {}) })), TypeError);
  const accessorDocument = document();
  Object.defineProperty(accessorDocument, 'objectUrl', { get: () => 'blob:document-1', enumerable: true });
  assert.throws(() => deriveViewerGridVisibility(input({ document: accessorDocument })), TypeError);
  assert.throws(() => deriveViewerGridVisibility(input({ document: document({ objectUrl: 'https://example.test/source.pdf' }) })), TypeError);
  assert.equal(isViewerDocumentBound(document({ objectUrl: 'https://example.test/source.pdf' })), false);
});

test('returns a primitive and does not mutate input state', () => {
  const value = input();
  const before = structuredClone(value);
  const result = deriveViewerGridVisibility(value);
  assert.equal(typeof result, 'boolean');
  assert.deepEqual(value, before);
});
