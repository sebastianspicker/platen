import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDF_ADVANCED_SEARCH_PROFILE, searchPdfAdvancedText } from '../scripts/host/pdf-advanced-search.mjs';

function request(pages, query, overrides = {}) {
  const sourceSha256 = createHash('sha256').update('immutable-source').digest('hex');
  return { profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256, pages, query, mode: 'literal', caseSensitive: true, wholeWord: false, context: 2, maxResults: 1000, ...overrides };
}

test('advanced search preserves UTF-16 offsets, snippets, page order, and deterministic repeatability', () => {
  const value = request([{ page: 1, text: '😀 Alpha beta' }, { page: 3, text: 'alpha ALPHA' }], 'Alpha', { caseSensitive: false });
  const first = searchPdfAdvancedText(value); const second = searchPdfAdvancedText(value); assert.deepEqual(first, second); assert.equal(first.totalMatches, 3); assert.deepEqual(first.matches.map(({ page, start, end }) => ({ page, start, end })), [{ page: 1, start: 3, end: 8 }, { page: 3, start: 0, end: 5 }, { page: 3, start: 6, end: 11 }]); assert.equal(first.matches[0].snippet.text, '😀 Alpha b');
});

test('advanced search applies whole-word Unicode boundaries and case modes', () => {
  const pages = [{ page: 1, text: 'cat scatter CAT_ caté CÁT' }]; assert.equal(searchPdfAdvancedText(request(pages, 'cat', { wholeWord: true })).totalMatches, 1); assert.equal(searchPdfAdvancedText(request(pages, 'cat', { wholeWord: true, caseSensitive: false })).totalMatches, 1);
});

test('advanced wildcard search supports bounded question/star tokens and non-overlap', () => {
  const pages = [{ page: 1, text: 'ab ac axxxc ac' }]; const result = searchPdfAdvancedText(request(pages, 'a*c', { mode: 'wildcard' })); assert.deepEqual(result.matches.map((match) => match.text), ['ab ac', 'axxxc', 'ac']);
  assert.equal(searchPdfAdvancedText(request([{ page: 1, text: 'cat cut cot' }], 'c?t', { mode: 'wildcard' })).totalMatches, 3);
  assert.throws(() => searchPdfAdvancedText(request(pages, '***', { mode: 'wildcard' })), { code: 'INVALID_PDF_ADVANCED_SEARCH' });
});

test('advanced search truncates deterministically and rejects malformed or hostile input', () => {
  const result = searchPdfAdvancedText(request([{ page: 1, text: 'x x x x' }], 'x', { maxResults: 2 })); assert.equal(result.totalMatches, 4); assert.equal(result.truncated, true); assert.equal(result.matches.length, 2);
  assert.throws(() => searchPdfAdvancedText(request([{ page: 2, text: 'x' }, { page: 1, text: 'x' }], 'x')), { code: 'INVALID_PDF_ADVANCED_SEARCH' });
  assert.deepEqual(searchPdfAdvancedText(request([{ page: 1, text: 'line\ntext' }], 'text')).matches[0].start, 5);
  assert.throws(() => searchPdfAdvancedText(request([{ page: 1, text: 'bad\u0000text' }], 'x')), { code: 'INVALID_PDF_ADVANCED_SEARCH' });
  assert.throws(() => searchPdfAdvancedText(request([{ page: 1, text: 'İstanbul' }], 'i', { caseSensitive: false })), { code: 'UNSUPPORTED_PDF_ADVANCED_SEARCH' });
  assert.throws(() => searchPdfAdvancedText(request([{ page: 1, text: 'a'.repeat(5_000) }], `${'a*'.repeat(60)}z`, { mode: 'wildcard' })), { code: 'UNSUPPORTED_PDF_ADVANCED_SEARCH' });
});

test('advanced search returns immutable evidence independent of later caller mutation', () => {
  const pages = [{ page: 1, text: 'immutable target' }]; const value = request(pages, 'target'); const result = searchPdfAdvancedText(value); pages[0].text = 'mutated'; value.query = 'mutated'; assert.equal(result.totalMatches, 1); assert.equal(result.matches[0].text, 'target');
});
