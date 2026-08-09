import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { AccessibilityRemediationService } from '../scripts/host/accessibility-remediation-service.mjs';
import { AccessibilityReviewService } from '../scripts/host/accessibility-review-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { createValidationEndpoints } from '../src/core/local-host-validation-endpoints.js';
import { createAccessibilityAltTextOperations } from '../src/controllers/review/accessibility-alt-text-operations.js';
import { invoke } from './support/host-router-fixture-base.js';
import { makeTextPdf } from './pdf-fixture.js';

const TOKEN = 'r'.repeat(64);
const ORIGIN = 'http://127.0.0.1:4173';

function authHeaders() {
  return { origin: ORIGIN, host: '127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': TOKEN };
}

function reviewPdfService(store) {
  return {
    async inspect() { return { pageCount: 1, tagged: 'no', title: 'R07 alt text fixture', form: 'none' }; },
    async inspectStructure(documentId, { lastPage, includeTagText }) {
      return { sourceDigest: store.getDocument(documentId).sha256, pageRange: { first: 1, last: lastPage }, taggedStructure: { present: false, includesText: includeTagText, lines: [] }, xmpMetadata: { xml: '<xmpmeta />' }, customMetadata: [], urls: [] };
    },
    async listFonts() { return []; },
    async listImages() { return [{ page: 1, number: 0, objectId: 8, generation: 0, width: 100, height: 200, rawImagePayload: 'R07-IMAGE-PAYLOAD' }]; },
    async extractText() { return [{ page: 1, text: 'R07-SECRET-EXTRACTED-TEXT' }]; },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r07-alt-text-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const document = await store.createDocument({ stream: Readable.from([Buffer.from(makeTextPdf('R07-SECRET-PDF-PAYLOAD'))]), displayName: 'r07-alt-text.pdf', mediaType: 'application/pdf' });
  const workspace = new WorkspaceStateStore(store);
  const accessibilityReviews = new AccessibilityReviewService({ store, pdfService: reviewPdfService(store) });
  const accessibilityRemediations = new AccessibilityRemediationService({ documentStore: store, workspaceStateStore: workspace, reviewProvider: accessibilityReviews, idFactory: () => 'accessibility-proposal-r07' });
  const app = createAppHandler({ staticHandler: () => {}, store, service: {}, workspaceState: workspace, accessibilityReviews, accessibilityRemediations, token: TOKEN, host: '127.0.0.1', port: 4173 });
  return { root, store, workspace, document, app, accessibilityReviews, accessibilityRemediations };
}

function routeClient(app) {
  const request = async (path, options = {}) => {
    const response = await invoke(app, { method: options.method ?? 'GET', url: path, headers: { ...authHeaders(), ...(options.method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: options.body });
    if (response.statusCode >= 400) throw Object.assign(new Error(`HTTP ${response.statusCode}`), JSON.parse(response.body).error);
    return response;
  };
  return createValidationEndpoints({
    json: async (path, options) => JSON.parse((await request(path, options)).body),
    text: async (path, options) => (await request(path, options)).body,
  });
}

test('human-authored NFC alt text is source/review/revision-bound and exported by server id without PDF or tag mutation', async (t) => {
  const state = await fixture(t);
  const sourceBefore = await readFile(state.store.getSourcePath(state.document.id));
  const reviewResponse = await invoke(state.app, { method: 'POST', url: `/api/documents/${state.document.id}/accessibility-review`, headers: authHeaders(), body: JSON.stringify({ profile: 'basic-local-review' }) });
  assert.equal(reviewResponse.statusCode, 200);
  const review = JSON.parse(reviewResponse.body).report;
  const candidate = review.remediationPlan.candidates.find((entry) => entry.action === 'author-image-alt-text');
  assert.ok(candidate);
  assert.equal(candidate.status, 'proposed-not-applied');
  const client = routeClient(state.app);
  const downloads = [];
  const model = {
    analysis: { documentId: state.document.id, sha256: state.document.sha256 }, document: { name: 'r07-alt-text.pdf' },
    host: { accessibilityRemediationReady: true }, busyAction: null, error: null, domainRevision: 0,
    accessibilityReviewResult: review, accessibilityAltTextCandidateLocator: candidate.target.locator,
    accessibilityAltText: '  Cafe\u0301 image  ', accessibilityAltTextProposalResult: null,
  };
  const operations = createAccessibilityAltTextOperations({
    state: model, client, BlobConstructor: Blob,
    captureOperation: () => ({ documentId: state.document.id, controller: new AbortController() }),
    operationIsCurrent: () => true, reportOperationError: (error) => { throw error; },
    finishOperation: () => { model.busyAction = null; }, render: () => {},
    triggerDownload: (download) => downloads.push(download),
  });
  await operations.createAccessibilityAltTextProposal();
  assert.equal(model.accessibilityAltTextProposalResult.status, 'proposed-not-applied');
  assert.equal(model.domainRevision, 1);
  assert.equal(downloads.length, 1);
  const exported = JSON.parse(await downloads[0].blob.text());
  assert.equal(exported.status, 'proposed-not-applied');
  assert.equal(exported.conformanceClaim, false);
  assert.equal(exported.sourceSha256, state.document.sha256);
  assert.equal(exported.reviewSha256, review.reportSha256);
  assert.equal(exported.operations[0].authoredText, 'Café image');
  assert.equal(downloads[0].fileName, 'r07-alt-text-image-alt-text-proposal.json');
  assert.equal(state.workspace.snapshot(state.document.id).namespaces.accessibilityTags[0].operations[0].authoredText, 'Café image');
  assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), sourceBefore);
  assert.equal(await state.store.verifySource(state.document.id), true);
  assert.doesNotMatch(await downloads[0].blob.text(), /R07-SECRET|%PDF|rawImagePayload/u);
});

test('alt-text proposals reject malformed, hostile, stale, and non-authoring inputs before mutation', async (t) => {
  const state = await fixture(t);
  const report = await state.accessibilityReviews.review(state.document.id);
  const candidate = report.remediationPlan.candidates.find((entry) => entry.action === 'author-image-alt-text');
  const request = { sourceSha256: state.document.sha256, reviewSha256: report.reportSha256, expectedWorkspaceRevision: 0, operations: [{ action: 'author-image-alt-text', target: { locator: candidate.target.locator }, authoredText: 'Description' }] };
  const client = routeClient(state.app);
  for (const bad of [
    { ...request, sourceSha256: 'B'.repeat(64) },
    { ...request, operations: [{ ...request.operations[0], authoredText: '' }] },
    { ...request, operations: [{ ...request.operations[0], authoredText: '/private/source.pdf' }] },
    { ...request, operations: [{ action: 'author-tag-tree', target: null, authoredText: 'generated' }] },
  ]) assert.throws(() => client.createAccessibilityProposal(state.document.id, bad), TypeError);
  const accessor = { ...request }; Object.defineProperty(accessor, 'reviewSha256', { enumerable: true, get() { throw new Error('must not read'); } });
  assert.throws(() => client.createAccessibilityProposal(state.document.id, accessor));
  const proxy = new Proxy(request, { ownKeys() { throw new Error('must not enumerate'); } });
  assert.throws(() => client.createAccessibilityProposal(state.document.id, proxy));
  await assert.rejects(state.accessibilityRemediations.createProposal(state.document.id, { ...request, reviewSha256: 'c'.repeat(64) }), { code: 'ACCESSIBILITY_PROPOSAL_REVIEW_STALE', status: 409 });
  assert.equal(state.workspace.snapshot(state.document.id).revision, 0);
  assert.equal(state.workspace.snapshot(state.document.id).namespaces.accessibilityTags.length, 0);
});
