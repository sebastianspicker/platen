import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDF_ADVANCED_SEARCH_PROFILE, searchPdfAdvancedText } from '../scripts/host/pdf-advanced-search.mjs';
import { normalizePdfAdvancedSearch } from '../scripts/host/pdf-advanced-search-contract.mjs';

function request(pages, query, overrides = {}) {
  const sourceSha256 = createHash('sha256').update('immutable-source').digest('hex');
  return { profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256, pages, query, mode: 'literal', caseSensitive: true, wholeWord: false, context: 2, maxResults: 1000, ...overrides };
}

function assertInvalid(action, message) {
  assert.throws(action, { code: 'INVALID_PDF_ADVANCED_SEARCH', ...(message ? { message } : {}) });
}

function descriptorOnlyProxy(target, events, label) {
  return new Proxy(target, {
    getPrototypeOf(value) { events.push(`${label}:prototype`); return Reflect.getPrototypeOf(value); },
    ownKeys(value) { events.push(`${label}:keys`); return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(value, key) { events.push(`${label}:descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(value, key); },
    get() { throw new Error(`${label} must not receive ordinary property reads`); },
  });
}

test('advanced-search normalization returns one exact frozen snapshot', () => {
  const sourceSha256 = 'a'.repeat(64);
  const value = request([{ page: 1, text: 'café' }], 'fé', { sourceSha256, context: 0, maxResults: 1 });
  const normalized = normalizePdfAdvancedSearch(value);
  assert.deepEqual(normalized, {
    profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256, pages: [{ page: 1, text: 'café' }], query: 'fé', mode: 'literal', caseSensitive: true, wholeWord: false, context: 0, maxResults: 1,
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.pages), true);
  assert.equal(Object.isFrozen(normalized.pages[0]), true);
  assert.notEqual(normalized.pages, value.pages);
  assert.notEqual(normalized.pages[0], value.pages[0]);
});

test('advanced-search normalization preserves descriptor-only root and page proxy acceptance', () => {
  const events = [];
  const sourceSha256 = createHash('sha256').update('immutable-source').digest('hex');
  const page = descriptorOnlyProxy({ page: 1, text: 'proxy text' }, events, 'page');
  const value = descriptorOnlyProxy(request([page], 'proxy', { sourceSha256 }), events, 'root');
  assert.deepEqual(normalizePdfAdvancedSearch(value), {
    profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256, pages: [{ page: 1, text: 'proxy text' }], query: 'proxy', mode: 'literal', caseSensitive: true, wholeWord: false, context: 2, maxResults: 1000,
  });
  assert.deepEqual(events, [
    'root:prototype', 'root:keys', 'root:descriptor:profile', 'root:descriptor:sourceSha256', 'root:descriptor:pages', 'root:descriptor:query', 'root:descriptor:mode', 'root:descriptor:caseSensitive', 'root:descriptor:wholeWord', 'root:descriptor:context', 'root:descriptor:maxResults', 'root:keys',
    'page:prototype', 'page:keys', 'page:descriptor:page', 'page:descriptor:text', 'page:keys',
  ]);
});

test('advanced-search normalization rejects accessors, non-enumerable fields, and symbols at every exact-object level', () => {
  const value = request([{ page: 1, text: 'text' }], 'text');
  const rootAccessor = { ...value }; Object.defineProperty(rootAccessor, 'query', { enumerable: true, get() { return 'text'; } });
  const rootHidden = { ...value }; Object.defineProperty(rootHidden, 'query', { enumerable: false, value: 'text' });
  const rootSymbol = { ...value, [Symbol('unexpected')]: true };
  const pageAccessor = { page: 1 }; Object.defineProperty(pageAccessor, 'text', { enumerable: true, get() { return 'text'; } });
  const pageHidden = { page: 1, text: 'text' }; Object.defineProperty(pageHidden, 'text', { enumerable: false, value: 'text' });
  const pageSymbol = { page: 1, text: 'text', [Symbol('unexpected')]: true };
  for (const candidate of [rootAccessor, rootHidden, rootSymbol]) assertInvalid(() => normalizePdfAdvancedSearch(candidate));
  for (const pages of [[pageAccessor], [pageHidden], [pageSymbol]]) assertInvalid(() => normalizePdfAdvancedSearch(request(pages, 'text')));
});

test('advanced-search normalization enforces ordered pages and the UTF-8 page-text cap', () => {
  assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 2, text: 'x' }, { page: 1, text: 'x' }], 'x')), 'Extracted pages must be strictly ascending.');
  assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 1, text: 'x' }, { page: 1, text: 'x' }], 'x')), 'Extracted pages must be strictly ascending.');
  assert.equal(normalizePdfAdvancedSearch(request([{ page: 1, text: '😀'.repeat(1024 * 1024) }], 'x')).pages[0].text.length, 2 * 1024 * 1024);
  assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 1, text: '😀'.repeat(1024 * 1024 + 1) }], 'x')), 'Extracted text exceeds the bounded UTF-8 limit.');
});

test('advanced-search normalization accepts the exact page and aggregate UTF-8 boundaries', () => {
  const maximumPages = Array.from({ length: 1000 }, (_, index) => ({ page: index + 1, text: '' }));
  assert.equal(normalizePdfAdvancedSearch(request(maximumPages, 'x')).pages.length, 1000);
  const chunk = 'x'.repeat(2 * 1024 * 1024);
  assert.equal(normalizePdfAdvancedSearch(request([{ page: 1, text: chunk }, { page: 2, text: chunk }], 'x')).pages.length, 2);
  assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 1, text: chunk }, { page: 2, text: `${chunk}x` }], 'x')), 'Extracted text exceeds the bounded UTF-8 limit.');
});

test('advanced-search normalization enforces Unicode, controls, wildcard anchors, and every option bound and type', () => {
  const base = request([{ page: 1, text: 'safe\ntext\t' }], '😀'.repeat(128));
  assert.equal(normalizePdfAdvancedSearch(base).query.length, 256);
  for (const query of ['e\u0301', 'safe\ntext', '😀'.repeat(129)]) assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 1, text: 'safe' }], query)));
  assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 1, text: 'safe\u0000' }], 'safe')));
  assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 1, text: 'safe' }], '*?', { mode: 'wildcard' })), 'Wildcard queries must contain a literal anchor.');
  assert.equal(normalizePdfAdvancedSearch(request([{ page: 1, text: 'safe' }], 's*', { mode: 'wildcard' })).mode, 'wildcard');
  for (const [key, values] of Object.entries({
    profile: ['wrong', null], sourceSha256: ['A'.repeat(64), 1], mode: ['regex', null], caseSensitive: [0, null], wholeWord: [1, null], context: [-1, 201, 1.5, '0'], maxResults: [0, 1001, 1.5, '1'],
  })) for (const value of values) assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 1, text: 'safe' }], 'safe', { [key]: value })));
  const nonNativeArray = [{ page: 1, text: 'safe' }]; Object.setPrototypeOf(nonNativeArray, null);
  for (const pages of [[], 'page', nonNativeArray, Array.from({ length: 1001 }, (_, index) => ({ page: index + 1, text: 'safe' })), [{ page: 0, text: 'safe' }], [{ page: 1.5, text: 'safe' }], [{ page: 1, text: 1 }]]) assertInvalid(() => normalizePdfAdvancedSearch(request(pages, 'safe')));
  assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 1, text: 'safe' }], '')));
  assertInvalid(() => normalizePdfAdvancedSearch(request([{ page: 2, text: 'safe' }, { page: 1, text: 'safe' }], '***', { mode: 'wildcard' })), 'Extracted pages must be strictly ascending.');
});

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
