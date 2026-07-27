import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INCREMENTAL_METADATA_FIELDS,
  INCREMENTAL_METADATA_PROFILE,
  normalizeIncrementalMetadata,
} from '../scripts/host/pdf-incremental-metadata-contract.mjs';

const valid = () => ({ title: 'Title', author: null, subject: '', keywords: 'alpha, beta' });

test('incremental metadata contract accepts and freezes exactly four nullable NFC fields', () => {
  const result = normalizeIncrementalMetadata(valid());
  assert.deepEqual(result, valid());
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(INCREMENTAL_METADATA_FIELDS, ['title', 'author', 'subject', 'keywords']);
  assert.equal(INCREMENTAL_METADATA_PROFILE, 'local-classic-incremental-metadata-v1');
});

test('incremental metadata contract rejects missing, extra, accessor, and symbol fields', () => {
  const missing = valid(); delete missing.keywords;
  const extra = { ...valid(), producer: 'unsafe' };
  const accessor = valid(); Object.defineProperty(accessor, 'title', { get: () => 'Title', enumerable: true });
  const symbol = valid(); symbol[Symbol('extra')] = true;
  for (const value of [null, [], missing, extra, accessor, symbol]) {
    assert.throws(() => normalizeIncrementalMetadata(value), { code: 'INVALID_INCREMENTAL_METADATA' });
  }
});

test('incremental metadata contract rejects oversized, non-NFC, surrogate, control, and format text', () => {
  const invalidValues = [
    'x'.repeat(1_025), 'e\u0301', '\ud800', '\udc00', 'line\nfeed', 'nul\0byte',
    'direction\u200E', 'join\u200D', ' leading', 'trailing ',
  ];
  for (const title of invalidValues) {
    assert.throws(
      () => normalizeIncrementalMetadata({ ...valid(), title }),
      { code: 'INVALID_INCREMENTAL_METADATA' },
    );
  }
  assert.equal(normalizeIncrementalMetadata({ ...valid(), title: 'é😀' }).title, 'é😀');
  assert.equal(Buffer.byteLength('😀'.repeat(256), 'utf8'), 1_024);
  assert.equal(normalizeIncrementalMetadata({ ...valid(), title: '😀'.repeat(256) }).title.length, 512);
});
