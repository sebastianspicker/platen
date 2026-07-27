import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDF_SPELLCHECK_PROFILE } from '../scripts/host/pdf-spellcheck-contract.mjs';
import { PdfSpellcheckService } from '../scripts/host/pdf-spellcheck-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111'; const sha256 = createHash('sha256').update('source').digest('hex');
const options = { dictionary: ['hello'], pages: null };
function fixture(overrides = {}) {
  const observed = { verify: 0, inspect: 0, extract: 0 }; const source = { id: documentId, sha256, size: 100, displayName: 'source.pdf' };
  const store = { getDocument: () => source, verifySource: async () => { observed.verify += 1; if (overrides.staleAfter && observed.verify > 1) throw Object.assign(new Error('stale'), { code: 'SOURCE_VERSION_MISMATCH' }); } };
  const inspection = { inspect: async () => { observed.inspect += 1; return { pageCount: overrides.pageCount ?? 1 }; }, extractText: async () => { observed.extract += 1; if (overrides.extractError) throw new Error('/private/source.pdf'); return overrides.pages ?? [{ page: 1, text: 'hello wrld' }]; } };
  return { service: new PdfSpellcheckService({ store, inspection, core: overrides.core }), observed };
}

test('spellcheck service returns source-bound review evidence and never an artifact', async () => {
  const setup = fixture(); const result = await setup.service.check(documentId, options, { sourceSha256: sha256 });
  assert.equal(result.kind, 'pdf-spellcheck-review'); assert.equal(result.report.sourceSha256, sha256); assert.equal(result.report.totalFindings, 1); assert.equal(result.evidence.contentChanged, false); assert.equal(result.report.pages[0].findings[0].reason, 'dictionary-miss'); assert.equal(setup.observed.verify, 2); assert.equal(setup.observed.inspect, 1); assert.equal(setup.observed.extract, 1); assert.equal(Object.hasOwn(result, 'artifact'), false);
});

test('spellcheck service rejects stale sources, hostile extraction, and invalid core output', async () => {
  await assert.rejects(fixture({ staleAfter: true }).service.check(documentId, options, { sourceSha256: sha256 }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  await assert.rejects(fixture({ pages: new Proxy([], { getOwnPropertyDescriptor() { throw new Error('trap'); } }) }).service.check(documentId, options, { sourceSha256: sha256 }), { code: 'PDF_SPELLCHECK_ENGINE_INVALID', status: 502 });
  await assert.rejects(fixture({ core: { buildPdfSpellcheckReport: () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } }) } }).service.check(documentId, options, { sourceSha256: sha256 }), { code: 'PDF_SPELLCHECK_OUTPUT_INVALID', status: 502 });
  const forgedCore = { buildPdfSpellcheckReport: (value) => ({ profile: PDF_SPELLCHECK_PROFILE, sourceSha256: value.request.sourceSha256, dictionaryDigest: 'f'.repeat(64), pages: [{ page: 999, tokenCount: 999, findings: [] }], totalTokens: 999, totalFindings: 0, truncated: false, authority: 'extracted-text-review-only-v1', linguisticCorrectnessClaim: false, contentChanged: false }) };
  await assert.rejects(fixture({ core: forgedCore }).service.check(documentId, options, { sourceSha256: sha256 }), { code: 'PDF_SPELLCHECK_OUTPUT_INVALID', status: 502 });
  await assert.rejects(fixture().service.check(documentId, options, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
});

test('spellcheck service maps cancellation and bounds page selection', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled')); await assert.rejects(fixture().service.check(documentId, options, { sourceSha256: sha256, signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  await assert.rejects(fixture({ pageCount: 1 }).service.check(documentId, { ...options, pages: [2] }, { sourceSha256: sha256 }), { code: 'PDF_SPELLCHECK_PAGE_LIMIT', status: 422 });
  await assert.rejects(fixture().service.check(documentId, new Proxy(options, { getOwnPropertyDescriptors() { throw new Error('trap'); } }), { sourceSha256: sha256 }), { code: 'INVALID_PDF_SPELLCHECK', status: 400 });
  assert.equal(PDF_SPELLCHECK_PROFILE, 'local-pdf-spellcheck-review-v1');
});
