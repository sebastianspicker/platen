import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createAppHandler } from '../scripts/host/router.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import {
  ELECTRONIC_SIGNING_INTENT_PROFILE,
  ElectronicSigningIntentService,
} from '../scripts/host/electronic-signing-intent-service.mjs';
import {
  OfflineSignatureService,
  SIGNATURE_TRUST_LIMITS,
} from '../scripts/host/offline-signature-service.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { invoke } from './support/host-router-fixture-base.js';
import { makeTextPdf } from './pdf-fixture.js';

const TOKEN = 'a'.repeat(64);
const SOURCE_OFFSET = 100;
const CMS = Buffer.from('30800000', 'hex');
const CMS_SHA256 = createHash('sha256').update(CMS).digest('hex');
const SOURCE_BYTES = (() => {
  const bytes = Buffer.from(makeTextPdf('R05 source-bound signing claim'));
  Buffer.from('<30800000>', 'ascii').copy(bytes, SOURCE_OFFSET);
  return bytes;
})();
const SOURCE_SHA256 = createHash('sha256').update(SOURCE_BYTES).digest('hex');
const SIGNATURE_BYTE_RANGE = Object.freeze([
  0,
  SOURCE_OFFSET,
  SOURCE_OFFSET + Buffer.byteLength('<30800000>', 'ascii'),
  SOURCE_BYTES.length - SOURCE_OFFSET - Buffer.byteLength('<30800000>', 'ascii'),
]);

function appFetch(app, { auth = true } = {}) {
  return async (path, options = {}) => {
    const headers = { origin: 'http://127.0.0.1:4173', host: '127.0.0.1:4173' };
    if (auth) headers['x-platen-token'] = TOKEN;
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key.toLowerCase()] = value;
    const response = await invoke(app, {
      method: options.method ?? 'GET',
      url: path,
      headers,
      body: options.body ?? '',
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}

function pdfsigOutput(input) {
  return [
    `Digital Signature Info of: ${input}`,
    'Signature #1:',
    '  - Signer Certificate Common Name: Unverified Claim',
    '  - Signer full Distinguished Name: CN=Unverified Claim',
    '  - Signing Time: Jul 19 2026 10:00:00',
    '  - Signing Hash Algorithm: SHA-256',
    '  - Signature Type: adbe.pkcs7.detached',
    `  - Signed Ranges: [0 - ${SIGNATURE_BYTE_RANGE[1]}], [${SIGNATURE_BYTE_RANGE[2]} - ${SOURCE_BYTES.length}]`,
    '  - Total document signed',
    '  - Signature Validation: Signature is Valid.',
    '',
  ].join('\n');
}

function nativeEvidence() {
  return {
    schema: 'macos-signature-chain-receipt-v2',
    profile: 'macos-basic-x509-current-trust-v2',
    sourceSha256: SOURCE_SHA256,
    evaluatedAt: '2026-08-04T10:00:00.000Z',
    verificationTimeBasis: 'host-current-time',
    anchorBasis: 'current-macos-trust-configuration',
    certificateNetworkFetchAllowed: false,
    records: [{
      byteRange: [...SIGNATURE_BYTE_RANGE],
      subFilter: 'adbe.pkcs7.detached',
      cmsSha256: CMS_SHA256,
      certificateChain: { status: 'passes', reason: 'none', chainLength: 2 },
    }],
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r05-signing-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const document = await store.createDocument({ stream: Readable.from([SOURCE_BYTES]), displayName: 'source.pdf', mediaType: 'application/pdf' });
  const workspaceState = new WorkspaceStateStore(store);
  const electronicSigningIntent = new ElectronicSigningIntentService({
    store,
    workspaceState,
    idFactory: () => 'r05-intent-1',
    clock: () => '2026-08-04T10:00:00.000Z',
  });
  const offlineSignature = new OfflineSignatureService({
    store,
    poppler: {
      async execute(operation, parameters, options) {
        assert.deepEqual(await readFile(parameters.input), SOURCE_BYTES);
        if (operation === 'dumpSignatures') {
          await writeFile(join(options.cwd, 'input.pdf.sig0'), CMS, { mode: 0o400 });
          return { stdout: 'Dumping Signatures: 1\nSignature #0 (4 bytes) => input.pdf.sig0\n', stderr: '', exitCode: 0 };
        }
        assert.equal(operation, 'verifySignatures');
        return { stdout: pdfsigOutput(parameters.input), stderr: '', exitCode: 0 };
      },
    },
    trust: {
      async evaluate({ requestPath }, options) {
        assert.equal(options.timeoutMs, 30_000);
        const request = JSON.parse(await readFile(requestPath, 'utf8'));
        assert.deepEqual(request, {
          version: 1,
          operation: 'validateEmbeddedCertificateChains',
          inputFilename: 'input.pdf',
          sourceSha256: SOURCE_SHA256,
          limits: SIGNATURE_TRUST_LIMITS,
          records: [{
            byteRange: [...SIGNATURE_BYTE_RANGE],
            subFilter: 'adbe.pkcs7.detached',
            cmsFilename: 'dumps/input.pdf.sig0',
            cmsSha256: CMS_SHA256,
          }],
        });
        return nativeEvidence();
      },
    },
  });
  const app = createAppHandler({
    staticHandler: () => {},
    store,
    service: { availability: async () => [], verifySignatures: offlineSignature.verify.bind(offlineSignature) },
    workspaceState,
    electronicSigningIntent,
    token: TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  const client = new LocalHostClient({ fetchImpl: appFetch(app) });
  return { root, store, document, workspaceState, electronicSigningIntent, offlineSignature, app, client };
}

test('sign.electronic records one source/revision-bound local consent intent without mutating PDF or claiming signing authority', async (t) => {
  const state = await fixture(t);
  const sourceBefore = await readFile(state.store.getSourcePath(state.document.id));
  await state.client.bootstrap();
  const result = await state.client.recordElectronicSigningIntent(state.document.id, {
    profile: ELECTRONIC_SIGNING_INTENT_PROFILE,
    sourceSha256: SOURCE_SHA256,
    expectedRevision: 0,
    signer: 'Ada Lovelace',
    intent: 'Approve this local copy',
    consent: true,
  });
  assert.equal(result.sourceSha256, SOURCE_SHA256);
  assert.equal(result.workspaceRevision, 1);
  assert.match(result.signerSha256, /^[0-9a-f]{64}$/u);
  assert.match(result.intentSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.consentRecorded, true);
  assert.equal(result.localOnly, true);
  for (const key of ['certificateSignature', 'identityVerified', 'timestampTrusted', 'legalEffectDetermined']) assert.equal(result[key], false);
  assert.match(result.limitations.join(' '), /No PDF appearance or mutation|No certificate|No audit-trail or routing/u);
  assert.equal('signer' in result, false);
  assert.equal('intent' in result, false);
  assert.equal('artifact' in result, false);
  assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), sourceBefore);
  const records = state.workspaceState.snapshot(state.document.id).namespaces.workflowRecords;
  assert.equal(records.length, 1);
  assert.equal(JSON.stringify(records[0]).includes('Ada Lovelace'), false);
  assert.equal(JSON.stringify(records[0]).includes('Approve this local copy'), false);
});

test('sign.electronic is authenticated, source/revision-bound, and cancellation cleans the retained record', async (t) => {
  const state = await fixture(t);
  const request = {
    profile: ELECTRONIC_SIGNING_INTENT_PROFILE,
    sourceSha256: SOURCE_SHA256,
    expectedRevision: 0,
    signer: 'Ada',
    intent: 'Approve',
    consent: true,
  };
  const unauthenticated = await invoke(state.app, {
    method: 'POST',
    url: `/api/documents/${state.document.id}/electronic-signing-intent`,
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  assert.equal(unauthenticated.statusCode, 401);
  await assert.rejects(state.electronicSigningIntent.record(state.document.id, { ...request, sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  await assert.rejects(state.electronicSigningIntent.record(state.document.id, { ...request, expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });

  const controller = new AbortController();
  const cancellingWorkspace = {
    snapshot: state.workspaceState.snapshot.bind(state.workspaceState),
    deleteEntity: state.workspaceState.deleteEntity.bind(state.workspaceState),
    createEntity(...args) {
      const value = state.workspaceState.createEntity(...args);
      controller.abort();
      return value;
    },
  };
  const cancellingService = new ElectronicSigningIntentService({ store: state.store, workspaceState: cancellingWorkspace, idFactory: () => 'cancelled-r05-intent' });
  await assert.rejects(cancellingService.record(state.document.id, request, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(state.workspaceState.snapshot(state.document.id).namespaces.workflowRecords, []);
});

test('sign.validate-certificate returns frozen v2 integrity, current-document, and current-machine path evidence without identity claims', async (t) => {
  const state = await fixture(t);
  await state.client.bootstrap();
  const result = await state.client.validateCertificateSignatures(state.document.id);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.sourceSha256, SOURCE_SHA256);
  assert.deepEqual(result.popplerEvidence, { engine: 'Poppler pdfsig', integrityStatus: 'valid', currentDocumentStatus: 'valid' });
  assert.deepEqual(result.cmsCrossCheck, { status: 'verified', verifiedCount: 1, indeterminateCount: 0, unsupportedCount: 0, reasons: [] });
  assert.equal(result.overallCurrentDocumentStatus, 'valid');
  assert.equal(result.certificateChainSummary, 'all-pass');
  assert.equal(result.certificateEvaluation.profile, 'macos-basic-x509-current-trust-v2');
  assert.equal(result.certificateEvaluation.anchorBasis, 'current-macos-trust-configuration');
  assert.equal(result.certificateEvaluation.certificateNetworkFetchAllowed, false);
  assert.equal(result.signatures[0].certificate, 'passes');
  assert.equal(result.signatures[0].certificateChain.status, 'passes');
  assert.equal(result.signatures[0].identityVerified, false);
  assert.equal(result.signatures[0].revocation, 'not-checked');
  assert.equal(result.signatures[0].timestamp, 'not-checked');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.signatures), true);
  assert.equal(Object.isFrozen(result.signatures[0].certificateChain), true);
  assert.doesNotMatch(JSON.stringify(result), /private-field-name|workspacePath|requestPath|input\.pdf|cmsFilename/u);
});

test('sign.validate-certificate rejects unauthenticated access and forged client evidence', async (t) => {
  const state = await fixture(t);
  const unauthenticated = await invoke(state.app, {
    method: 'GET',
    url: `/api/documents/${state.document.id}/signatures`,
    headers: { origin: 'http://127.0.0.1:4173' },
  });
  assert.equal(unauthenticated.statusCode, 401);
  const bootstrapToken = 'f'.repeat(64);
  const forgedClient = new LocalHostClient({
    fetchImpl: async (path) => {
      if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: bootstrapToken }), { status: 200 });
      const forged = {
        sourceSha256: SOURCE_SHA256.toUpperCase(),
        schemaVersion: 2,
        profile: 'poppler-offline-integrity-v1',
        status: 'valid', integrityStatus: 'valid', coverageStatus: 'full', currentDocumentStatus: 'valid',
        count: 0, signatureCount: 0, summary: 'No embedded signatures', signatures: [],
        limitations: ['Certificate trust was not checked.'],
        popplerEvidence: { engine: 'Poppler pdfsig', integrityStatus: 'valid', currentDocumentStatus: 'valid' },
        cmsCrossCheck: { status: 'verified', verifiedCount: 0, indeterminateCount: 0, unsupportedCount: 0, reasons: [] },
        overallCurrentDocumentStatus: 'valid', certificateChainSummary: 'unsupported',
        certificateEvaluation: { profile: 'macos-basic-x509-current-trust-v2', evaluatedAt: '2026-08-04T10:00:00.000Z', verificationTimeBasis: 'host-current-time', anchorBasis: 'current-macos-trust-configuration', certificateNetworkFetchAllowed: false },
      };
      return new Response(JSON.stringify({ signatures: forged }), { status: 200 });
    },
  });
  await forgedClient.bootstrap();
  await assert.rejects(forgedClient.validateCertificateSignatures(state.document.id), TypeError);
});
