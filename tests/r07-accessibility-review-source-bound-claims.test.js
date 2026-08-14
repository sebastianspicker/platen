import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { ACCESSIBILITY_REVIEW_LIMITATIONS } from '../scripts/host/accessibility-review-report.mjs';
import { AccessibilityReviewService } from '../scripts/host/accessibility-review-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { createAccessibilityReviewOperations } from '../src/controllers/review/accessibility-review-operations.js';
import { createJsonDownload } from '../src/controllers/review/json-download.js';
import { invoke } from './support/host-router-fixture-base.js';
import { makeTextPdf } from './pdf-fixture.js';

const TOKEN = 'r'.repeat(64);
const ORIGIN = 'http://127.0.0.1:4173';

function reviewPdfService(store) {
  return {
    async inspect() {
      return { pageCount: 1, tagged: 'no', title: 'R07 fixture', form: 'none' };
    },
    async inspectStructure(documentId, { lastPage, includeTagText }) {
      return {
        sourceDigest: store.getDocument(documentId).sha256,
        pageRange: { first: 1, last: lastPage },
        taggedStructure: { present: false, includesText: includeTagText, lines: [] },
        xmpMetadata: { xml: '<xmpmeta />' },
        customMetadata: [],
        urls: [{ objectId: 9 }],
      };
    },
    async listFonts() {
      return [{ unicode: 'yes', embedded: 'yes' }];
    },
    async listImages() {
      return [{
        page: 1, number: 0, objectId: 8, generation: 0, width: 100, height: 200,
        rawImagePayload: 'R07-IMAGE-PAYLOAD',
      }];
    },
    async extractText() {
      return [{ page: 1, text: 'R07-SECRET-EXTRACTED-TEXT' }];
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r07-accessibility-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourceBytes = Buffer.from(makeTextPdf('R07-SECRET-PDF-PAYLOAD'));
  const document = await store.createDocument({
    stream: Readable.from([sourceBytes]), displayName: 'r07-source.pdf', mediaType: 'application/pdf',
  });
  let verifyCount = 0;
  const originalVerifySource = store.verifySource.bind(store);
  store.verifySource = async (...args) => {
    verifyCount += 1;
    return originalVerifySource(...args);
  };
  const accessibilityReviews = new AccessibilityReviewService({
    store,
    pdfService: reviewPdfService(store),
  });
  const app = createAppHandler({
    staticHandler: () => {},
    store,
    service: {},
    workspaceState: new WorkspaceStateStore(store),
    accessibilityReviews,
    token: TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  return { app, document, sourcePath: store.getSourcePath(document.id), store, get verifyCount() { return verifyCount; } };
}

function authHeaders() {
  return {
    origin: ORIGIN,
    host: '127.0.0.1:4173',
    'content-type': 'application/json',
    'x-platen-token': TOKEN,
  };
}

test('accessibility.check uses an authenticated immutable source and returns only bounded review evidence', async (t) => {
  const state = await fixture(t);
  const sourceBefore = await readFile(state.sourcePath);
  const response = await invoke(state.app, {
    method: 'POST',
    url: `/api/documents/${state.document.id}/accessibility-review`,
    headers: authHeaders(),
    body: JSON.stringify({ profile: 'basic-local-review' }),
  });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(Object.keys(body), ['report']);
  const report = body.report;
  assert.equal(report.sourceDigest, state.document.sha256);
  assert.deepEqual(report.profile, {
    id: 'basic-local-review', title: 'Basic local accessibility review', version: 3,
  });
  assert.equal(report.remediationPlan.sourceSha256, state.document.sha256);
  assert.equal(report.remediationPlan.status, 'proposal-only');
  assert.equal(report.remediationPlan.candidates.every(({ status }) => status === 'proposed-not-applied'), true);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 128 * 1024);
  assert.deepEqual(report.limitations, ACCESSIBILITY_REVIEW_LIMITATIONS);
  assert.equal(report.checks.find(({ id }) => id === 'pdf-ua-conformance').status, 'not-checked');
  assert.match(report.limitations.join(' '), /PDF\/UA conformance claim/u);
  assert.equal('document' in report, false);
  assert.equal('sourcePath' in report, false);
  assert.equal('pdf' in report, false);
  assert.equal('image' in report, false);
  assert.doesNotMatch(response.body.toString('utf8'), /R07-SECRET-EXTRACTED-TEXT|R07-IMAGE-PAYLOAD|R07-SECRET-PDF-PAYLOAD|%PDF/u);
  assert.equal(state.verifyCount, 2);
  assert.deepEqual(await readFile(state.sourcePath), sourceBefore);
  assert.equal(await state.store.verifySource(state.document.id), true);
  assert.equal(state.verifyCount, 3);
});

test('accessibility.report-export exports that exact source-bound report as browser JSON without applying or retaining an artifact', async (t) => {
  const state = await fixture(t);
  const response = await invoke(state.app, {
    method: 'POST',
    url: `/api/documents/${state.document.id}/accessibility-review`,
    headers: authHeaders(),
    body: JSON.stringify({ profile: 'basic-local-review' }),
  });
  assert.equal(response.statusCode, 200);
  const report = JSON.parse(response.body).report;
  const sourceBefore = await readFile(state.sourcePath);
  const downloads = [];
  const calls = [];
  const stateModel = {
    analysis: { documentId: state.document.id, sha256: state.document.sha256 },
    document: { name: 'r07-source.pdf' },
    accessibilityReviewResult: report,
  };
  const operations = createAccessibilityReviewOperations({
    state: stateModel,
    client: { runAccessibilityReview: async () => { calls.push('run'); } },
    captureOperation: () => ({ controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: () => {},
    finishOperation: () => {},
    triggerDownload: (download) => downloads.push(download),
    jsonDownload: createJsonDownload({
      triggerDownload: (download) => downloads.push(download),
      BlobConstructor: Blob,
      json: JSON,
    }),
    render: () => {},
    announce: () => {},
  });
  operations.exportAccessibilityReview();
  assert.equal(calls.length, 0);
  assert.equal(downloads.length, 1);
  const download = downloads[0];
  assert.equal(download.fileName, 'r07-source-accessibility-review.json');
  const exported = JSON.parse(await download.blob.text());
  assert.equal(exported.sourceDigest, state.document.sha256);
  assert.equal(exported.reportSha256, report.reportSha256);
  assert.deepEqual(exported, report);
  assert.equal(await download.blob.text(), JSON.stringify(report, null, 2));
  assert.equal(download.blob.type, 'application/json');
  assert.equal(stateModel.accessibilityReviewResult, report);
  assert.deepEqual(await readFile(state.sourcePath), sourceBefore);
  assert.equal(await state.store.verifySource(state.document.id), true);
  assert.throws(
    () => state.store.getArtifact('00000000-0000-4000-8000-000000000000'),
    { code: 'ARTIFACT_NOT_FOUND' },
  );
  assert.equal(report.remediationPlan.candidates.some(({ status }) => status !== 'proposed-not-applied'), false);
  assert.equal('pdf' in report, false);
  assert.doesNotMatch(await download.blob.text(), /R07-SECRET-EXTRACTED-TEXT|R07-IMAGE-PAYLOAD|%PDF/u);
});
