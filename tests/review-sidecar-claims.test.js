import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PdfReviewSidecarService } from '../scripts/host/pdf-review-sidecar-service.mjs';
import { handleReviewSidecarRoute } from '../scripts/host/routes/review-sidecar-routes.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { createReviewSidecarEndpoints } from '../src/core/local-host-review-sidecar-endpoints.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'a'.repeat(64);

function annotation(id, page, status = 'open') {
  return {
    id,
    prototypeSidecar: true,
    type: 'comment',
    page,
    rectangle: [1, 2, 3, 4],
    text: `retained ${id}`,
    author: 'local-reviewer',
    status,
    properties: {},
    mentions: [],
    createdAt: `2026-08-03T10:0${page}:00.000Z`,
    replies: [],
  };
}

function setup() {
  const documents = {
    getDocument: (id) => ({ id, sha256: SOURCE }),
    verifySource: async () => true,
  };
  const workspace = new WorkspaceStateStore((id) => id === DOCUMENT_ID);
  workspace.createEntity(DOCUMENT_ID, 'annotations', annotation('annotation-1', 1));
  workspace.createEntity(DOCUMENT_ID, 'annotations', annotation('annotation-2', 2));
  workspace.createEntity(DOCUMENT_ID, 'reviewRecords', {
    id: 'activity-1', kind: 'activity', annotationId: 'annotation-1', activity: 'created',
    actor: 'local-sidecar', detail: 'created locally', at: '2026-08-03T10:02:00.000Z',
  });
  workspace.createEntity(DOCUMENT_ID, 'reviewRecords', {
    id: 'participant-1', kind: 'participant', participantId: 'not-an-exposed-tracking-field',
  });
  const service = new PdfReviewSidecarService({ documents, workspace, clock: () => '2026-08-03T10:03:00.000Z' });
  return { documents, workspace, service };
}

function endpointFor(state) {
  return createReviewSidecarEndpoints({
    json: async (path, options) => {
      const operation = path.endsWith('/review-sidecar-status') ? 'review-sidecar-status' : 'review-sidecar-inspect';
      const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
      let body;
      await handleReviewSidecarRoute({
        operation,
        request: { method: 'POST' },
        response,
        url: new URL(`http://local.test/api/documents/${DOCUMENT_ID}/${operation}`),
        documentId: DOCUMENT_ID,
        processing: { signal: options.signal ?? new AbortController().signal },
        reviewSidecar: state.service,
        bodyLimit: 32_768,
        method: (request, expected) => assert.equal(request.method, expected),
        readJson: async () => JSON.parse(options.body),
        json: (_response, status, value) => {
          assert.equal(status, 200);
          body = value;
        },
      });
      return body;
    },
  });
}

test('R04 review claims stay in the source-bound local sidecar path', async () => {
  const state = setup();
  const endpoint = endpointFor(state);
  const initialRevision = state.workspace.snapshot(DOCUMENT_ID).revision;

  const status = await endpoint.setReviewSidecarStatus(DOCUMENT_ID, {
    sourceSha256: SOURCE,
    expectedRevision: initialRevision,
    annotationId: 'annotation-1',
    status: 'custom',
    customStatus: 'needs-local-review',
  });
  assert.equal(status.localOnly, true);
  assert.equal(status.sourceDigest, SOURCE);
  assert.equal(status.revision, initialRevision + 1);
  assert.equal(state.workspace.snapshot(DOCUMENT_ID).namespaces.annotations[0].customStatus, 'needs-local-review');

  const inspected = await endpoint.inspectReviewSidecar(DOCUMENT_ID, {
    sourceSha256: SOURCE,
    expectedRevision: status.revision,
    query: { search: '', status: null, type: null, groupBy: 'none', sortBy: 'page', direction: 'desc' },
  });
  assert.equal(inspected.localOnly, true);
  assert.deepEqual(inspected.annotationsOrGroups.map(({ id }) => id), ['annotation-2', 'annotation-1']);
  assert.equal(inspected.count, 2);
  assert.deepEqual(inspected.commentSummary.map(({ id }) => id), ['annotation-1', 'annotation-2']);
  assert.equal(inspected.activity.length, 2);
  assert.equal(inspected.activity.some(({ id }) => id === 'activity-1'), true);
  assert.equal(Object.hasOwn(inspected, 'csv'), false);
  assert.equal(Object.hasOwn(inspected, 'xfdf'), false);
  assert.equal(Object.hasOwn(inspected, 'printable'), false);
  assert.equal(inspected.activity.every(({ kind }) => kind === 'activity'), true);
  assert.equal(inspected.activity.some(({ kind }) => kind === 'participant'), false);
  assert.equal(Object.hasOwn(inspected, 'participants'), false);
  assert.equal(Object.hasOwn(inspected, 'dueDates'), false);
  assert.equal(Object.hasOwn(inspected, 'outstandingAssignments'), false);
  assert.equal(Object.hasOwn(inspected, 'pdfHistory'), false);
});
