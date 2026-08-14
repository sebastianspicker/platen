import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PAGE_TEXT_CLIPBOARD_UNITS,
  clipboardTextWritingAvailable,
  pageTextForClipboard,
} from '../src/core/page-text-clipboard.js';

test('page text clipboard accepts only one trimmed bounded physical page text', () => {
  const pages = [{ page: 1, text: '  exact\npage text  ' }, { page: 2, text: 'other' }];
  assert.equal(pageTextForClipboard(pages, 1), 'exact\npage text');
  assert.equal(pageTextForClipboard(pages, 2), 'other');
  assert.equal(pageTextForClipboard(pages, 3), null);
  assert.equal(pageTextForClipboard([{ page: 1, text: '  ' }], 1), null);
  assert.equal(pageTextForClipboard([{ page: 1, text: 'x'.repeat(MAX_PAGE_TEXT_CLIPBOARD_UNITS + 1) }], 1), null);
  assert.equal(pageTextForClipboard([{ page: 1, text: '😀'.repeat(10_000) }], 1)?.length, 20_000);
  assert.equal(pageTextForClipboard([{ page: 1, text: '😀'.repeat(10_001) }], 1), null);
  assert.equal(pageTextForClipboard([{ page: 1, text: 1 }], 1), null);
});

test('page text clipboard requires the text Clipboard API', () => {
  assert.equal(clipboardTextWritingAvailable({ writeText: async () => {} }), true);
  assert.equal(clipboardTextWritingAvailable({ write: async () => {} }), false);
  assert.equal(clipboardTextWritingAvailable(null), false);
});
