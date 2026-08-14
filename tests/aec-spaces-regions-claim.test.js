import assert from 'node:assert/strict';
import test from 'node:test';

import { DomainFacade } from '../scripts/host/domain-facade.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_B = 'b'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

const VALID_POINTS = Object.freeze([
  { x: 0, y: 0 },
  { x: 72, y: 0 },
  { x: 72, y: 72 },
  { x: 0, y: 72 },
]);

function expectedPdfMetrics(points) {
  let area = 0;
  let perimeter = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
    perimeter += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return {
    areaPdfPoints2: Number(Math.abs(area / 2).toFixed(6)),
    perimeterPdfPoints: Number(perimeter.toFixed(6)),
  };
}

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound spaces and regions'),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).document;
}

function responseCode(response) {
  return JSON.parse(response.body).error.code;
}

function callDomain(handler, documentId, body) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify(body),
  });
}

async function createSpace(handler, documentId, sourceSha256, revision, overrides = {}) {
  return callDomain(handler, documentId, {
    group: 'AEC',
    operation: 'createSpace',
    body: {
      input: {
        name: 'Space Alpha',
        kind: 'space',
        points: overrides.points ?? VALID_POINTS,
        page: overrides.page ?? 1,
        ...overrides,
        sourceSha256,
      },
      options: { expectedRevision: revision },
    },
  });
}

test('authenticated source-bound createSpace stores source-bound record and deterministic geometry metrics', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const revision = workspaceState.snapshot(document.id).revision;

  const valid = await createSpace(handler, document.id, sourceSha256, revision);
  assert.equal(valid.statusCode, 200);
  const record = JSON.parse(valid.body).result.namespaces.metadata.at(-1);
  assert.equal(record.kind, 'space');
  assert.equal(record.name, 'Space Alpha');
  assert.equal(record.page, 1);
  assert.equal(record.sourceSha256, sourceSha256);
  assert.equal(record.basisRevision, revision);
  assert.deepEqual(record.metrics, expectedPdfMetrics(VALID_POINTS));
  assert.equal(Object.hasOwn(record, 'pdf'), false);
});

test('source-bound space creation rejects forged digest, stale revision, and invalid page', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const initial = workspaceState.snapshot(document.id).revision;
  const valid = await createSpace(handler, document.id, sourceSha256, initial);
  assert.equal(valid.statusCode, 200);

  const stale = await createSpace(handler, document.id, sourceSha256, 0);
  assert.equal(stale.statusCode, 409);
  assert.equal(responseCode(stale), 'REVISION_CONFLICT');

  const forged = await createSpace(handler, document.id, SOURCE_B, workspaceState.snapshot(document.id).revision);
  assert.equal(forged.statusCode, 409);
  assert.equal(responseCode(forged), 'SOURCE_VERSION_MISMATCH');

  const highPage = await createSpace(handler, document.id, sourceSha256, workspaceState.snapshot(document.id).revision, { page: 100_001 });
  assert.equal(highPage.statusCode, 400);
  assert.equal(responseCode(highPage), 'INVALID_PARAMETER');

  const fractionalPage = await createSpace(handler, document.id, sourceSha256, workspaceState.snapshot(document.id).revision, { page: 1.5 });
  assert.equal(fractionalPage.statusCode, 400);
  assert.equal(responseCode(fractionalPage), 'INVALID_PARAMETER');
});

test('source-bound space geometry rejects invalid coordinate topology', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const current = workspaceState.snapshot(document.id).revision;

  const duplicateVertex = await createSpace(handler, document.id, sourceSha256, current, {
    points: [{ x: 0, y: 0 }, { x: 72, y: 0 }, { x: 72, y: 0 }, { x: 0, y: 72 }],
  });
  assert.equal(duplicateVertex.statusCode, 400);
  assert.equal(responseCode(duplicateVertex), 'AEC_GEOMETRY_DEGENERATE');

  const zeroArea = await createSpace(handler, document.id, sourceSha256, current, {
    points: [{ x: 0, y: 0 }, { x: 72, y: 0 }, { x: 144, y: 0 }],
  });
  assert.equal(zeroArea.statusCode, 400);
  assert.equal(responseCode(zeroArea), 'AEC_GEOMETRY_DEGENERATE');

  const selfCrossing = await createSpace(handler, document.id, sourceSha256, current, {
    points: [{ x: 0, y: 0 }, { x: 144, y: 144 }, { x: 0, y: 144 }, { x: 144, y: 0 }],
  });
  assert.equal(selfCrossing.statusCode, 400);
  assert.equal(responseCode(selfCrossing), 'AEC_GEOMETRY_SELF_INTERSECTS');

  const outOfBounds = await createSpace(handler, document.id, sourceSha256, current, {
    points: [{ x: 1_000_001, y: 0 }, { x: 0, y: 72 }, { x: 0, y: 0 }],
  });
  assert.equal(outOfBounds.statusCode, 400);
});

test('legacy createSpace remains source-unbound and accepts preexisting non-source behaviors', () => {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  const facade = new DomainFacade(store);
  let state = store.snapshot(DOCUMENT_ID);
  state = facade.execute(DOCUMENT_ID, {
    group: 'AEC',
    operation: 'createSpace',
    body: { input: { id: 'legacy', name: 'Legacy Region', kind: 'legacy-space', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }, options: { expectedRevision: state.revision } },
  });
  const record = state.namespaces.metadata.at(-1);
  assert.equal(record.kind, 'legacy-space');
  assert.equal(record.page, undefined);
  assert.equal(record.sourceSha256, undefined);
  assert.equal(record.basisRevision, undefined);
  assert.equal(record.metrics, undefined);
});
