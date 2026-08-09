import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainFacade, DOMAIN_OPERATION_REGISTRY } from '../scripts/host/domain-facade.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
function setup() {
  let id = 0;
  return new DomainFacade(new WorkspaceStateStore((value) => value === documentId), {
    domainOptions: {
      reviewForms: { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++id}` },
      aec: { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++id}` },
      collaboration: { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++id}` },
      redaction: { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++id}` },
      accessibility: { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++id}` },
      signing: { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++id}` },
    },
  });
}

test('the facade explicitly maps every safe public domain method and documents unsupported operations', () => {
  const operations = setup().listOperations();
  assert.deepEqual(operations, DOMAIN_OPERATION_REGISTRY);
  const supported = Object.values(operations).flatMap((group) => Object.entries(group).filter(([, entry]) => entry.supported).map(([name]) => name));
  // 17 review/forms, 17 AEC, 15 collaboration, and 7 trust-domain methods
  // are prototype-safe and mapped to their single-owner services.
  assert.equal(supported.length, 56);
  assert.deepEqual(Object.keys(operations.review), ['createAnnotation', 'reply', 'updateAnnotation', 'setReviewState', 'queryAnnotations', 'exportReviewJson', 'importReviewJson', 'reviewSummary']);
  assert.deepEqual(Object.keys(operations.forms).slice(0, 9), ['createField', 'setValue', 'resetValues', 'validate', 'submitResponse', 'exportForms', 'importForms', 'detectFields', 'staticToFillable']);
  assert.deepEqual(Object.keys(operations.AEC), ['snapshot', 'createToolset', 'createReviewSession', 'measurementToolset', 'createMarkup', 'listMarkups', 'createCustomColumn', 'evaluateCustomColumn', 'createSpace', 'createDrawingSet', 'createSheet', 'createRevisionOverlay', 'createBatchPlan', 'legends', 'calibrateGeoPage', 'pageToGeo', 'takeoff']);
  assert.deepEqual(Object.keys(operations.collaboration), ['createProject', 'createRevision', 'transitionRevision', 'createWorkspace', 'createReviewSession', 'recordParticipant', 'recordActivity', 'createNotification', 'createSharePackage', 'recordVersion', 'createRepositoryConnector', 'createRetentionRule', 'checkout', 'checkin', 'appendSyncJournal']);
  assert.deepEqual(Object.keys(operations.redaction).slice(0, 2), ['detectSensitiveText', 'createRedactionPlan']);
  assert.deepEqual(Object.keys(operations.accessibility), ['inspect', 'exportReport', 'proposeRemediation']);
  assert.deepEqual(Object.keys(operations.signing).slice(0, 2), ['createElectronicIntent', 'verifyLocalIntent']);
  assert.equal(operations.redaction.apply.supported, false);
  assert.match(operations.redaction.apply.semantics, /irreversible/);
  assert.equal(operations.signing.certificateSigning.supported, false);
  assert.equal(operations.forms.xfa.supported, false);
  assert.equal(Object.hasOwn(operations.AEC, 'calibrateScale'), false);
  assert.equal(Object.hasOwn(operations.AEC, 'measure'), false);
});

test('the facade dispatches named operations, returns JSON-safe data, and preserves domain errors', () => {
  const facade = setup();
  const created = facade.execute(documentId, { group: 'review', operation: 'createAnnotation', body: { input: { type: 'comment', page: 1, rectangle: [0, 0, 1, 1], text: 'check', author: 'Ada' }, options: { expectedRevision: 0 } } });
  assert.equal(created.revision, 1);
  const annotations = facade.execute(documentId, { group: 'review', operation: 'queryAnnotations', body: { query: {} } });
  assert.deepEqual(annotations.map((item) => item.text), ['check']);
  assert.throws(() => facade.execute(documentId, { group: 'review', operation: 'createAnnotation', body: { input: { type: 'bad', page: 1, rectangle: [0, 0, 1, 1] } } }), { code: 'INVALID_ANNOTATION_TYPE' });
  assert.doesNotThrow(() => JSON.stringify(created));
});

test('the facade rejects unknown groups, arbitrary methods, unsupported operations, and non-JSON request bodies', () => {
  const facade = setup();
  assert.throws(() => facade.execute(documentId, { group: 'review', operation: 'constructor', body: {} }), { code: 'DOMAIN_OPERATION_UNSUPPORTED' });
  assert.throws(() => facade.execute(documentId, { group: 'unknown', operation: 'anything', body: {} }), { code: 'DOMAIN_GROUP_UNSUPPORTED' });
  assert.throws(() => facade.execute(documentId, { group: 'redaction', operation: 'apply', body: {} }), { code: 'DOMAIN_OPERATION_UNSUPPORTED' });
  assert.throws(() => facade.execute(documentId, { group: 'signing', operation: 'certificateSigning', body: {} }), { code: 'DOMAIN_OPERATION_UNSUPPORTED' });
  assert.throws(() => facade.execute(documentId, { group: 'AEC', operation: 'legends', body: { value: Number.NaN } }), { code: 'INVALID_DOMAIN_BODY' });
});
