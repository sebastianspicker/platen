import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDF_SPELLCHECK_PROFILE, normalizePdfSpellcheckRequest } from '../scripts/host/pdf-spellcheck-contract.mjs';
import { buildPdfSpellcheckReport, snapshotPdfSpellcheckReport } from '../scripts/host/pdf-spellcheck-report.mjs';

const sha256 = createHash('sha256').update('source').digest('hex');
const request = { profile: PDF_SPELLCHECK_PROFILE, sourceSha256: sha256, dictionary: ['Hello', 'world'], pages: null };

test('spellcheck contract canonicalizes a bounded local dictionary and preserves page scope', () => {
  const normalized = normalizePdfSpellcheckRequest({ ...request, dictionary: ['WORLD', 'hello', 'hello'] });
  assert.deepEqual(normalized.dictionary, ['hello', 'world']);
  assert.equal(normalized.pages, null);
  assert.throws(() => normalizePdfSpellcheckRequest({ ...request, dictionary: ['bad\u202Eword'] }), { code: 'INVALID_PDF_SPELLCHECK' });
  assert.throws(() => normalizePdfSpellcheckRequest({ ...request, pages: [2, 2] }), { code: 'INVALID_PDF_SPELLCHECK' });
});

test('spellcheck report is deterministic review evidence without source text or mutation', () => {
  const pages = [{ page: 1, text: 'Hello wrld.' }, { page: 2, text: 'world' }];
  const report = buildPdfSpellcheckReport({ request, pages });
  assert.equal(report.totalTokens, 3);
  assert.equal(report.totalFindings, 1);
  assert.equal(report.pages[0].findings[0].tokenLength, 4);
  assert.equal(report.pages[0].findings[0].tokenSha256, createHash('sha256').update('wrld').digest('hex'));
  assert.equal('text' in report.pages[0], false);
  assert.equal(report.contentChanged, false);
  assert.equal(report.linguisticCorrectnessClaim, false);
  assert.deepEqual(buildPdfSpellcheckReport({ request, pages }), report);
});

test('spellcheck report rejects proxy and accessor output before reading it', () => {
  assert.throws(() => snapshotPdfSpellcheckReport(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } })), { code: 'PDF_SPELLCHECK_OUTPUT_INVALID' });
  const report = buildPdfSpellcheckReport({ request, pages: [{ page: 1, text: 'Hello' }] });
  const hostile = { ...report }; Object.defineProperty(hostile, 'totalTokens', { enumerable: true, get() { throw new Error('accessor'); } });
  assert.throws(() => snapshotPdfSpellcheckReport(hostile), { code: 'PDF_SPELLCHECK_OUTPUT_INVALID' });
});

test('spellcheck report marks truncation only when dictionary misses overflow the retained cap', () => {
  const exact = buildPdfSpellcheckReport({ request, pages: [{ page: 1, text: `${'x '.repeat(9_999)}x` }] });
  const overflow = buildPdfSpellcheckReport({ request, pages: [{ page: 1, text: `${'x '.repeat(10_000)}x` }] });
  assert.equal(exact.totalFindings, 10_000);
  assert.equal(exact.truncated, false);
  assert.equal(overflow.totalFindings, 10_000);
  assert.equal(overflow.totalTokens, 10_001);
  assert.equal(overflow.truncated, true);
});
