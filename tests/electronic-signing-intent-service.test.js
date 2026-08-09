import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  ELECTRONIC_SIGNING_INTENT_PROFILE,
  ElectronicSigningIntentService,
} from '../scripts/host/electronic-signing-intent-service.mjs';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_SHA256 = 'a'.repeat(64);

function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function fixture(options = {}) {
  const state = { revision: 0, records: [] };
  const calls = { verifySource: 0, deletes: [] };
  const document = { id: DOCUMENT_ID, sha256: SOURCE_SHA256 };
  const store = {
    getDocument(id) { assert.equal(id, DOCUMENT_ID); return document; },
    async verifySource(id) { calls.verifySource += 1; assert.equal(id, DOCUMENT_ID); if (options.verifyFailure) throw new Error('verify failed'); },
  };
  const workspace = {
    snapshot(id) { assert.equal(id, DOCUMENT_ID); return { documentId: id, revision: state.revision, namespaces: { workflowRecords: state.records.map((record) => ({ ...record })) } }; },
    createEntity(id, namespace, record, { expectedRevision } = {}) {
      assert.equal(id, DOCUMENT_ID); assert.equal(namespace, 'workflowRecords'); assert.equal(expectedRevision, state.revision);
      state.records.push({ ...record }); state.revision += 1;
      if (options.abortAfterCreate) options.abortAfterCreate();
      return this.snapshot(id);
    },
    deleteEntity(id, namespace, recordId, { expectedRevision } = {}) {
      calls.deletes.push({ id, namespace, recordId, expectedRevision });
      if (options.cleanupFailure) throw new Error('cleanup failed');
      assert.equal(expectedRevision, state.revision);
      state.records = state.records.filter((record) => record.id !== recordId); state.revision += 1;
      return this.snapshot(id);
    },
  };
  if (options.forgeReadback) workspace.snapshot = (id) => ({ documentId: id, revision: state.revision, namespaces: { workflowRecords: state.records.map((record) => ({ ...record, intentSha256: 'f'.repeat(64) })) } });
  return {
    service: new ElectronicSigningIntentService({ store, workspaceState: workspace, idFactory: () => 'intent-1', clock: () => '2026-08-04T00:00:00.000Z' }),
    request: { profile: ELECTRONIC_SIGNING_INTENT_PROFILE, sourceSha256: SOURCE_SHA256, expectedRevision: 0, signer: 'Ada', intent: 'Approve this copy', consent: true },
    state, calls,
  };
}

test('records an exact local receipt and stores only digests', async () => {
  const value = fixture();
  const receipt = await value.service.record(DOCUMENT_ID, value.request);
  assert.deepEqual(receipt, {
    kind: 'electronic-signing-intent', profile: ELECTRONIC_SIGNING_INTENT_PROFILE, documentId: DOCUMENT_ID,
    sourceSha256: SOURCE_SHA256, workspaceRevision: 1, recordId: 'intent-1', signerSha256: digest('Ada'),
    intentSha256: digest('Approve this copy'), consentRecorded: true, localOnly: true,
    certificateSignature: false, identityVerified: false, timestampTrusted: false, legalEffectDetermined: false,
    limitations: [
      'Local record only; no external electronic-signing authority is contacted.',
      'No PDF appearance or mutation is performed.',
      'No certificate, identity, trusted-timestamp, or legal-effect claim is made.',
      'No audit-trail or routing claim is made.',
    ],
  });
  assert.equal(Object.isFrozen(receipt), true); assert.equal(Object.isFrozen(receipt.limitations), true);
  assert.equal(JSON.stringify(value.state.records[0]).includes('Ada'), false);
  assert.equal(JSON.stringify(value.state.records[0]).includes('Approve this copy'), false);
  assert.equal(value.calls.verifySource, 1);
});

test('binds the retained source digest and exact workspace revision', async () => {
  const staleSource = fixture();
  await assert.rejects(staleSource.service.record(DOCUMENT_ID, { ...staleSource.request, sourceSha256: 'b'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  const staleRevision = fixture();
  await assert.rejects(staleRevision.service.record(DOCUMENT_ID, { ...staleRevision.request, expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });
});

test('rejects hostile request shapes without invoking accessors or accepting extras', async () => {
  const value = fixture();
  const getter = { ...value.request }; Object.defineProperty(getter, 'signer', { enumerable: true, get() { throw new Error('getter invoked'); } });
  await assert.rejects(value.service.record(DOCUMENT_ID, getter), { code: 'INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST' });
  await assert.rejects(value.service.record(DOCUMENT_ID, new Proxy(value.request, {})), { code: 'INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST' });
  await assert.rejects(value.service.record(DOCUMENT_ID, { ...value.request, extra: true }), { code: 'INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST' });
  const symbol = { ...value.request }; symbol[Symbol('extra')] = true;
  await assert.rejects(value.service.record(DOCUMENT_ID, symbol), { code: 'INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST' });
  await assert.rejects(value.service.record(DOCUMENT_ID, { ...value.request, signer: 'x'.repeat(81) }), { code: 'INVALID_ELECTRONIC_SIGNING_INTENT_REQUEST' });
});

test('cancellation before create does not mutate; cancellation after create cleans only its record', async () => {
  const before = fixture(); const pre = new AbortController(); pre.abort();
  await assert.rejects(before.service.record(DOCUMENT_ID, before.request, { signal: pre.signal }), { code: 'JOB_CANCELLED' });
  assert.equal(before.state.records.length, 0); assert.equal(before.calls.deletes.length, 0);
  const afterController = new AbortController();
  const after = fixture({ abortAfterCreate: () => afterController.abort() });
  await assert.rejects(after.service.record(DOCUMENT_ID, after.request, { signal: afterController.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(after.calls.deletes, [{ id: DOCUMENT_ID, namespace: 'workflowRecords', recordId: 'intent-1', expectedRevision: 1 }]);
  assert.equal(after.state.records.length, 0);
});

test('forged readback and cleanup failure are fail-closed', async () => {
  const forged = fixture({ forgeReadback: true });
  await assert.rejects(forged.service.record(DOCUMENT_ID, forged.request), { code: 'ELECTRONIC_SIGNING_INTENT_READBACK_INVALID' });
  assert.deepEqual(forged.calls.deletes, [{ id: DOCUMENT_ID, namespace: 'workflowRecords', recordId: 'intent-1', expectedRevision: 1 }]);
  const cleanup = fixture({ forgeReadback: true, cleanupFailure: true });
  const error = await cleanup.service.record(DOCUMENT_ID, cleanup.request).catch((failure) => failure);
  assert.equal(error.code, 'ELECTRONIC_SIGNING_INTENT_CLEANUP_FAILED');
  assert.ok(error.cause instanceof AggregateError);
  assert.equal(error.message.includes('Approve'), false);
  await assert.rejects(fixture({ verifyFailure: true }).service.record(DOCUMENT_ID, fixture().request), { code: 'SOURCE_INTEGRITY_FAILED' });
});
