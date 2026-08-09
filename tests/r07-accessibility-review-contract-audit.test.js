import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccessibilityReviewService,
  ACCESSIBILITY_REVIEW_PROFILE,
  ACCESSIBILITY_REVIEW_VERSION,
  DEFAULT_ACCESSIBILITY_REVIEW_LIMITS,
} from '../scripts/host/accessibility-review-service.mjs';
import {
  ACCESSIBILITY_REVIEW_LIMITATIONS,
} from '../scripts/host/accessibility-review-report.mjs';
import { validateAccessibilityReviewReport } from '../scripts/host/accessibility-review-report-validation.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createAccessibilityReviewOperations } from '../src/controllers/review/accessibility-review-operations.js';
import {
  fixture as hostFixture,
  invoke,
  makeTextPdf,
  Readable,
} from './support/host-router-fixture.js';

const SOURCE_DIGEST = 'a'.repeat(64);
const TOKEN = 'b'.repeat(64);

function reviewFixture() {
  const store = {
    getDocument: (id) => ({ id, sha256: SOURCE_DIGEST }),
    async verifySource() { return true; },
  };
  const pdfService = {
    async inspect() {
      return { pageCount: 1, tagged: 'yes', title: 'Fixture title', form: 'none' };
    },
    async inspectStructure() {
      return {
        sourceDigest: SOURCE_DIGEST,
        taggedStructure: {
          present: true,
          lines: [{ depth: 0, value: 'Document' }, { depth: 2, value: 'P' }],
        },
        xmpMetadata: { xml: '<dc:language><rdf:Bag><rdf:li>en-US</rdf:li></rdf:Bag></dc:language>' },
        customMetadata: [],
        urls: [],
      };
    },
    async listFonts() { return [{ unicode: 'yes', embedded: 'yes' }]; },
    async listImages() { return []; },
    async extractText() { return [{ page: 1, text: 'fixture text' }]; },
  };
  const service = new AccessibilityReviewService({ store, pdfService });
  return { service, store, pdfService };
}

function resignReview(report, mutate) {
  const changed = structuredClone(report);
  mutate(changed);
  const { reportSha256: _oldDigest, ...unsigned } = changed;
  // Deliberately retain the original digest so semantic tampering is checked
  // before the trusted-issue boundary.
  return { ...unsigned, reportSha256: report.reportSha256 };
}

test('R07 accessibility review contract is fixed, source-bound, and tamper-resistant', async () => {
  assert.equal(ACCESSIBILITY_REVIEW_PROFILE, 'basic-local-review');
  assert.equal(ACCESSIBILITY_REVIEW_VERSION, 3);
  assert.deepEqual(DEFAULT_ACCESSIBILITY_REVIEW_LIMITS, {
    maxPages: 200,
    maxReportBytes: 128 * 1024,
  });
  assert.deepEqual(ACCESSIBILITY_REVIEW_LIMITATIONS, [
    'No PDF mutation was performed; every remediation candidate is proposed-not-applied.',
    'Tag-role shape checks are bounded heuristics and do not prove reading order or semantics.',
    'No page text, source path, image content, or PDF/UA conformance claim is returned.',
  ]);
  assert.throws(
    () => {
      const fixture = reviewFixture();
      return new AccessibilityReviewService({
        store: fixture.store,
        pdfService: fixture.pdfService,
        limits: { maxPages: 201 },
      });
    },
    TypeError,
  );

  const { service } = reviewFixture();
  const report = await service.review('document-1');
  assert.deepEqual(report.profile, {
    id: ACCESSIBILITY_REVIEW_PROFILE,
    title: 'Basic local accessibility review',
    version: ACCESSIBILITY_REVIEW_VERSION,
  });
  assert.deepEqual(report.limitations, ACCESSIBILITY_REVIEW_LIMITATIONS);
  assert.equal(report.sourceDigest, SOURCE_DIGEST);
  assert.equal('document' in report, false);
  assert.equal(validateAccessibilityReviewReport(report, { expectedSourceDigest: SOURCE_DIGEST }), report);

  const tampered = { ...report, reportSha256: 'c'.repeat(64) };
  assert.throws(
    () => validateAccessibilityReviewReport(tampered, { expectedSourceDigest: SOURCE_DIGEST }),
    { code: 'ACCESSIBILITY_REVIEW_INTEGRITY_FAILED' },
  );
  const leaked = resignReview(report, (changed) => {
    changed.checks[0].summary = 'Raw extracted text SECRET from /private/input.pdf';
  });
  assert.throws(
    () => validateAccessibilityReviewReport(leaked, { expectedSourceDigest: SOURCE_DIGEST, requireTrustedIssue: false }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID' },
  );
  assert.throws(
    () => validateAccessibilityReviewReport(structuredClone(report), { expectedSourceDigest: SOURCE_DIGEST }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID' },
  );
});

test('R07 accessibility review route, client, and export stay authenticated and JSON-only', async (context) => {
  const { service } = reviewFixture();
  const report = await service.review('document-1');
  const { handler, store } = await hostFixture(context);
  const document = await store.createDocument({
    stream: Readable.from([makeTextPdf('R07 ACCESSIBILITY')]),
    displayName: 'r07.pdf',
  });
  const route = `/api/documents/${document.id}/accessibility-review`;
  const authHeaders = {
    origin: 'http://127.0.0.1:4173',
    'content-type': 'application/json',
    'x-platen-token': 'test-session-token',
  };
  const unauthorized = await invoke(handler, {
    method: 'POST', url: route,
    headers: { origin: authHeaders.origin, 'content-type': authHeaders['content-type'] },
    body: JSON.stringify({ profile: ACCESSIBILITY_REVIEW_PROFILE }),
  });
  assert.equal(unauthorized.statusCode, 401);
  const valid = await invoke(handler, {
    method: 'POST', url: route, headers: authHeaders,
    body: JSON.stringify({ profile: ACCESSIBILITY_REVIEW_PROFILE }),
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(Object.keys(JSON.parse(valid.body)), ['report']);
  const wrongMethod = await invoke(handler, {
    method: 'GET', url: route,
    headers: { 'x-platen-token': 'test-session-token' },
  });
  assert.equal(wrongMethod.statusCode, 405);

  const calls = [];
  const client = new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: TOKEN }), { status: 200 });
      return new Response(JSON.stringify({ report: { kind: 'accessibility-review' } }), { status: 200 });
    },
  });
  await client.bootstrap();
  const clientResult = await client.runAccessibilityReview('doc/1');
  assert.deepEqual(clientResult, { kind: 'accessibility-review' });
  assert.equal(calls[1].path, '/api/documents/doc%2F1/accessibility-review');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: ACCESSIBILITY_REVIEW_PROFILE });
  assert.equal(calls[1].options.headers['X-Platen-Token'], TOKEN);
  assert.throws(
    () => client.runAccessibilityReview('doc', { profile: 'pdf-ua' }),
    TypeError,
  );

  const state = {
    analysis: { documentId: 'doc', sha256: SOURCE_DIGEST },
    document: { name: 'r07.pdf' },
    busyAction: null,
    accessibilityReviewResult: report,
  };
  const downloads = [];
  const operations = createAccessibilityReviewOperations({
    state,
    client: { runAccessibilityReview: async () => report },
    BlobConstructor: Blob,
    captureOperation: () => ({ controller: new AbortController(), documentId: 'doc' }),
    operationIsCurrent: () => true,
    reportOperationError: () => {},
    finishOperation: () => { state.busyAction = null; },
    triggerDownload: () => { throw new Error('binary export is outside this contract'); },
    render: () => {},
    announce: () => {},
    jsonDownload: (...args) => downloads.push(args),
  });
  operations.exportAccessibilityReview();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0][1], 'r07-accessibility-review.json');
  assert.match(downloads[0][2], /exported as JSON/u);
  assert.equal(typeof operations.runAccessibilityReview, 'function');
});
