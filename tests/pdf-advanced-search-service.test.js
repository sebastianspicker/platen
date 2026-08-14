import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDF_ADVANCED_SEARCH_PROFILE } from '../scripts/host/pdf-advanced-search.mjs';
import { PdfAdvancedSearchService } from '../scripts/host/pdf-advanced-search-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111'; const sha256 = createHash('sha256').update('source').digest('hex');
function fixture(options = {}) {
  const observed = { verify: 0, inspect: 0, extract: 0 }; const source = { id: documentId, sha256, size: 100, displayName: 'source.pdf' };
  const store = { getDocument: () => source, verifySource: async () => { observed.verify += 1; if (options.staleAfter && observed.verify > 1) throw new Error('stale path'); } };
  const inspection = { inspect: async (_id, value) => { observed.inspect += 1; if (options.inspectError) throw new Error('/private/path.pdf leaked'); return { pageCount: options.pageCount ?? 2, ...value }; }, extractText: async (_id, count, value) => { observed.extract += 1; if (options.extractError) throw new Error('/private/path.pdf leaked'); return options.pages ?? Array.from({ length: count }, (_, index) => ({ page: index + 1, text: index === 0 ? '😀 Target' : 'other' })); } };
  const core = options.core ?? { searchPdfAdvancedText: (request) => ({ profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256: request.sourceSha256, matches: [{ page: 1, start: 3, end: 9, text: 'Target', snippet: { text: '😀 Target', start: 0, end: 9 } }], totalMatches: 1, truncated: false }) };
  return { service: new PdfAdvancedSearchService({ store, inspection, core }), observed };
}
const options = { query: 'Target', mode: 'literal', caseSensitive: false, wholeWord: true, context: 2, maxResults: 10 };

test('advanced-search service forwards bounded inspection and returns source-bound UTF-16 evidence', async () => {
  const setup = fixture(); const result = await setup.service.search(documentId, options, { sourceSha256: sha256 }); assert.equal(result.sourceSha256, sha256); assert.equal(result.matches[0].start, 3); assert.match(result.limitations[0], /extracted text only/); assert.equal(setup.observed.verify, 2); assert.equal(setup.observed.inspect, 1); assert.equal(setup.observed.extract, 1);
});

test('advanced-search service snapshots exact options and maps stale, invalid, and bounded engine results', async () => {
  const setup = fixture(); const pending = setup.service.search(documentId, options, { sourceSha256: sha256 }); options.query = 'mutated'; const result = await pending; assert.equal(result.matches[0].text, 'Target');
  await assert.rejects(setup.service.search(documentId, { ...options, query: 'x', extra: true }, { sourceSha256: sha256 }), { code: 'PDF_ADVANCED_SEARCH_OPTIONS_INVALID', status: 400 });
  await assert.rejects(setup.service.search(documentId, options, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  await assert.rejects(fixture({ pageCount: 1001 }).service.search(documentId, options, { sourceSha256: sha256 }), { code: 'PDF_ADVANCED_SEARCH_PAGE_LIMIT', status: 422 });
});

test('advanced-search service maps core, engine, cancellation, timeout, and after-read stale failures without path leaks', async () => {
  await assert.rejects(fixture({ core: { searchPdfAdvancedText: () => { const error = new Error('/private/path.pdf'); error.code = 'INVALID_PDF_ADVANCED_SEARCH'; throw error; } } }).service.search(documentId, options, { sourceSha256: sha256 }), { code: 'PDF_ADVANCED_SEARCH_OPTIONS_INVALID', status: 400 });
  await assert.rejects(fixture({ inspectError: true }).service.search(documentId, options, { sourceSha256: sha256 }), (error) => error.code === 'PDF_ADVANCED_SEARCH_ENGINE_FAILED' && !error.message.includes('/private'));
  const controller = new AbortController(); controller.abort(new Error('cancel')); await assert.rejects(fixture().service.search(documentId, options, { sourceSha256: sha256, signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  await assert.rejects(fixture({ staleAfter: true }).service.search(documentId, options, { sourceSha256: sha256 }), { code: 'PDF_ADVANCED_SEARCH_ENGINE_FAILED', status: 502 });
});
