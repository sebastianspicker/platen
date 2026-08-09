import assert from 'node:assert/strict';
import test from 'node:test';
import { PDF_SENSITIVE_PATTERN_LIMITATIONS, PDF_SENSITIVE_PATTERN_PROFILE } from '../src/core/pdf-sensitive-pattern-contract.js';
import { PdfSensitivePatternService } from '../scripts/host/pdf-sensitive-pattern-service.mjs';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_SHA256 = 'a'.repeat(64);

function fixture({ pages = [{ page: 1, text: 'Contact alice@example.com or +1 (415) 555-2671. Card 4111 1111 1111 1111 and 4111 1111 1111 1112.' }], verifySource, inspect = () => ({ pageCount: pages.length }), extract = () => pages } = {}) {
  const document = { id: DOCUMENT_ID, sha256: SOURCE_SHA256 };
  let verifies = 0;
  const store = {
    getDocument: () => document,
    async verifySource() { verifies += 1; await verifySource?.(verifies, document); return true; },
  };
  const inspection = { inspect: async (...args) => inspect(...args), extractText: async (...args) => extract(...args) };
  const service = new PdfSensitivePatternService({ store, inspection });
  return { service, document, get verifies() { return verifies; } };
}

function request(customPatterns = []) {
  return { profile: PDF_SENSITIVE_PATTERN_PROFILE, sourceSha256: SOURCE_SHA256, customPatterns };
}

test('find returns built-in and custom matches without plaintext or paths', async () => {
  const value = fixture();
  const result = await value.service.find(DOCUMENT_ID, request([
    { label: 'Ticket', pattern: 'Contact', regex: false },
    { label: 'Domain', pattern: 'example\\.com', regex: true },
  ]));
  assert.equal(result.kind, 'pdf-sensitive-pattern-scan');
  assert.deepEqual(result.matches.map(({ kind, label }) => ({ kind, label })), [
    { kind: 'custom-literal', label: 'Ticket' }, { kind: 'email', label: 'Email' },
    { kind: 'custom-regex', label: 'Domain' }, { kind: 'phone', label: 'Phone' },
    { kind: 'payment-card', label: 'Payment card' },
  ]);
  assert.equal(result.matchCount, 5);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.evidence, { sourceDigestReverified: true, sourceUnchanged: true, localOnly: true, textReturned: false, pathsReturned: false, bounded: true });
  assert.deepEqual(result.limitations, PDF_SENSITIVE_PATTERN_LIMITATIONS);
  assert.doesNotMatch(JSON.stringify(result), /alice@example\.com|415\) 555|4111 1111|\/private\/|\.pdf/u);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.matches), true);
});

test('rejects invalid Luhn cards and bounds custom patterns', async () => {
  const value = fixture({ pages: [{ page: 1, text: '4111 1111 1111 1112' }] });
  const result = await value.service.find(DOCUMENT_ID, request());
  assert.equal(result.matchCount, 0);
  await assert.rejects(value.service.find(DOCUMENT_ID, request(Array.from({ length: 21 }, () => ({ label: 'x', pattern: 'x', regex: false })))), { code: 'PDF_SENSITIVE_PATTERN_REQUEST_INVALID', status: 400 });
  await assert.rejects(value.service.find(DOCUMENT_ID, request([{ label: 'evil', pattern: '(a+)+$', regex: true }])), { code: 'PDF_SENSITIVE_PATTERN_REQUEST_INVALID', status: 400 });
});

test('reverifies source and rejects drift, malformed extraction, and page/text bounds', async () => {
  const drift = fixture({ verifySource: (count, document) => { if (count === 2) document.sha256 = 'b'.repeat(64); } });
  await assert.rejects(drift.service.find(DOCUMENT_ID, request()), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  const malformed = fixture({ extract: () => [{ page: 1, text: 'ok', extra: true }] });
  await assert.rejects(malformed.service.find(DOCUMENT_ID, request()), { code: 'PDF_SENSITIVE_PATTERN_ENGINE_INVALID', status: 502 });
  const oversized = fixture({ extract: () => [{ page: 1, text: 'x'.repeat(100_001) }] });
  await assert.rejects(oversized.service.find(DOCUMENT_ID, request()), { code: 'PDF_SENSITIVE_PATTERN_TEXT_LIMIT', status: 422 });
  const pages = fixture({ inspect: () => ({ pageCount: 201 }), extract: () => [] });
  await assert.rejects(pages.service.find(DOCUMENT_ID, request()), { code: 'PDF_SENSITIVE_PATTERN_PAGE_LIMIT', status: 422 });
});

test('honors cancellation before and during extraction', async () => {
  const pre = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(pre.service.find(DOCUMENT_ID, request(), { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  let during;
  const midController = new AbortController();
  during = fixture({ extract: async () => { midController.abort(); return [{ page: 1, text: 'safe' }]; } });
  await assert.rejects(during.service.find(DOCUMENT_ID, request(), { signal: midController.signal }), { code: 'JOB_CANCELLED', status: 499 });
});
