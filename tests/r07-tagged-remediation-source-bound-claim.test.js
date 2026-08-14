import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { PdfTaggedRemediationService } from '../scripts/host/pdf-tagged-remediation-service.mjs';
import {
  TAGGED_PDF_REMEDIATION_MAX_CONTENTS,
  TAGGED_PDF_REMEDIATION_MAX_DEPTH,
  TAGGED_PDF_REMEDIATION_MAX_NODES,
  TAGGED_PDF_REMEDIATION_MAX_PAGES,
  TAGGED_PDF_REMEDIATION_PROFILE,
} from '../scripts/host/pdf-tagged-remediation-contract.mjs';
import { inspectTaggedPdfRemediation, writeTaggedPdfRemediation } from '../scripts/host/pdf-tagged-remediation-writer.mjs';
import { normalizeTaggedPdfRemediationRequest } from '../scripts/host/pdf-tagged-remediation-contract.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { createTaggedRemediationEndpoints } from '../src/core/local-host-tagged-remediation-endpoints.js';
import { invoke } from './support/host-router-fixture-base.js';
import { makeTextPdf } from './pdf-fixture.js';

const TOKEN = 'r07-tagged-remediation-token';
const ORIGIN = 'http://127.0.0.1:4173';
const SOURCE_MARKER = 'R07-TAGGED-SOURCE-PRIVATE-TEXT';
const PDF_BYTES_MARKER = '%PDF-1.7';

function planRequest(document) {
  return {
    profile: TAGGED_PDF_REMEDIATION_PROFILE,
    sourceSha256: document.sha256,
    plan: {
      id: 'document', role: 'Document', children: [
        { id: 'paragraph', role: 'P', page: 1, contentIndex: 0 },
      ],
    },
    language: 'en-US', title: 'R07 tagged document', roleMap: {},
  };
}

function authHeaders() {
  return {
    host: '127.0.0.1:4173', origin: ORIGIN,
    'content-type': 'application/json', 'x-platen-token': TOKEN,
  };
}

async function fixture(t, { core = null, drift = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r07-tagged-claim-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourceBytes = Buffer.from(makeTextPdf(SOURCE_MARKER));
  const document = await store.createDocument({
    stream: Readable.from([sourceBytes]), displayName: 'r07-tagged-source.pdf', mediaType: 'application/pdf',
  });
  const sourcePath = store.getSourcePath(document.id);
  const observed = { verify: 0, workspaces: [], cleaned: [], promoted: 0 };
  const verifySource = store.verifySource.bind(store);
  store.verifySource = async (...args) => {
    observed.verify += 1;
    if (drift && observed.verify === 2) await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('DRIFT')]));
    return verifySource(...args);
  };
  const createJobWorkspace = store.createJobWorkspace.bind(store);
  store.createJobWorkspace = async (...args) => {
    const workspace = await createJobWorkspace(...args);
    observed.workspaces.push(workspace);
    return workspace;
  };
  const cleanupJob = store.cleanupJob.bind(store);
  store.cleanupJob = async (workspace) => {
    observed.cleaned.push(workspace);
    return cleanupJob(workspace);
  };
  const promotePdfArtifact = store.promotePdfArtifact.bind(store);
  store.promotePdfArtifact = async (...args) => {
    observed.promoted += 1;
    return promotePdfArtifact(...args);
  };
  const service = new PdfTaggedRemediationService({ store, core: core ?? undefined });
  const app = createAppHandler({
    staticHandler: () => {}, store, service: {},
    workspaceState: new WorkspaceStateStore(store),
    taggedRemediation: service, taggedRemediationReady: true,
    token: TOKEN, host: '127.0.0.1', port: 4173,
  });
  return { root, store, document, sourcePath, sourceBytes, service, app, observed };
}

function realCore(overrides = {}) {
  return {
    normalizeTaggedPdfRemediation: normalizeTaggedPdfRemediationRequest,
    writeTaggedPdfRemediation,
    inspectTaggedPdfRemediation,
    ...overrides,
  };
}

test('authenticated tagged remediation applies one bounded plan and retains a separate digest-bound artifact', async (t) => {
  const state = await fixture(t);
  const request = planRequest(state.document);
  assert.equal(TAGGED_PDF_REMEDIATION_MAX_PAGES, 100);
  assert.equal(TAGGED_PDF_REMEDIATION_MAX_NODES, 1_024);
  assert.equal(TAGGED_PDF_REMEDIATION_MAX_DEPTH, 32);
  assert.equal(TAGGED_PDF_REMEDIATION_MAX_CONTENTS, 2_000);

  const unauthenticated = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.document.id}/tagged-remediation`,
    headers: { host: authHeaders().host, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  assert.equal(unauthenticated.statusCode, 401);
  const response = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.document.id}/tagged-remediation`,
    headers: authHeaders(), body: JSON.stringify(request),
  });
  assert.equal(response.statusCode, 201);
  const result = JSON.parse(response.body).result;
  assert.equal(result.kind, 'tagged-pdf-remediation');
  assert.equal(result.sourceDigest, state.document.sha256);
  assert.equal(result.evidence.sourceBound, true);
  assert.equal(result.evidence.sourceUnchanged, true);
  assert.equal(result.evidence.outputDigestBound, true);
  assert.equal(result.evidence.independentInspection, true);
  assert.equal(result.proof.sourcePrefixPreserved, true);
  assert.equal(result.proof.originalContentStreamsUnchanged, true);
  assert.ok(result.proof.revisionCount >= 2);
  assert.equal(result.artifact.documentId, state.document.id);
  assert.notEqual(result.artifact.id, state.document.id);
  assert.equal(Object.hasOwn(result.artifact, 'filePath'), false);
  assert.deepEqual(Object.keys(result.evidence).sort(), [
    'independentInspection', 'outputDigestBound', 'sourceBound', 'sourceUnchanged',
  ]);
  assert.ok(result.artifact.operation.validation.validators.includes('tagged-remediation-independent-reinspection'));
  assert.match(result.limitations.join(' '), /does not claim PDF\/UA conformance/u);
  assert.match(result.limitations.join(' '), /reading-order correctness/u);
  assert.match(result.limitations.join(' '), /whole-document accessibility remediation/u);

  const retained = state.store.getArtifact(result.artifact.id);
  const sourceAfter = await readFile(state.sourcePath);
  const output = await readFile(retained.filePath);
  assert.deepEqual(sourceAfter, state.sourceBytes);
  assert.equal(retained.sha256, result.proof.outputSha256);
  assert.ok(output.length > sourceAfter.length);
  assert.deepEqual(output.subarray(0, sourceAfter.length), sourceAfter);
  assert.equal(await state.store.verifySource(state.document.id), true);
  assert.ok(state.observed.verify >= 3);
  assert.equal(state.observed.workspaces.length, state.observed.cleaned.length);
  for (const workspace of state.observed.workspaces) await assert.rejects(access(workspace));
  assert.doesNotMatch(response.body.toString('utf8'), new RegExp(`${SOURCE_MARKER}|${PDF_BYTES_MARKER}|${state.sourcePath}`, 'u'));

  const publicEndpoint = createTaggedRemediationEndpoints({ json: async () => JSON.parse(response.body) });
  const publicResult = await publicEndpoint.updateTaggedRemediation(state.document.id, request);
  assert.equal(publicResult.artifact.id, result.artifact.id);
  assert.equal(Object.isFrozen(publicResult.artifact.operation), true);

  const endpoint = createTaggedRemediationEndpoints({ json: async () => { throw new Error('transport must not run'); } });
  assert.throws(() => endpoint.updateTaggedRemediation(state.document.id, { ...request, plan: null }), TypeError);
});

test('tagged remediation rejects query, over-bounded plans, digest drift, cancellation, tamper, and hostile descriptors', async (t) => {
  const state = await fixture(t);
  const request = planRequest(state.document);
  const query = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.document.id}/tagged-remediation?unsafe=1`,
    headers: authHeaders(), body: JSON.stringify(request),
  });
  assert.equal(query.statusCode, 400);
  assert.equal(JSON.parse(query.body).error.code, 'INVALID_PARAMETER');
  const extra = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.document.id}/tagged-remediation`,
    headers: authHeaders(), body: JSON.stringify({ ...request, unsafe: true }),
  });
  assert.equal(extra.statusCode, 400);
  const overBound = structuredClone(request);
  overBound.plan.children[0].page = 101;
  const bounded = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.document.id}/tagged-remediation`,
    headers: authHeaders(), body: JSON.stringify(overBound),
  });
  assert.equal(bounded.statusCode, 400);
  assert.equal(state.observed.promoted, 0);

  const drift = await fixture(t, { drift: true });
  await assert.rejects(drift.service.update(drift.document.id, planRequest(drift.document), { sourceSha256: drift.document.sha256 }), { code: 'SOURCE_INTEGRITY_FAILED' });
  assert.equal(drift.observed.promoted, 0);

  const controller = new AbortController();
  const cancelled = await fixture(t, { core: realCore({
    writeTaggedPdfRemediation(source, value) {
      controller.abort(new Error('cancelled by test'));
      return writeTaggedPdfRemediation(source, value);
    },
  }) });
  await assert.rejects(cancelled.service.update(cancelled.document.id, planRequest(cancelled.document), { sourceSha256: cancelled.document.sha256, signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.equal(cancelled.observed.promoted, 0);

  const tampered = await fixture(t, { core: realCore({
    inspectTaggedPdfRemediation(...args) {
      return { ...inspectTaggedPdfRemediation(...args), outputSha256: 'f'.repeat(64) };
    },
  }) });
  await assert.rejects(tampered.service.update(tampered.document.id, planRequest(tampered.document), { sourceSha256: tampered.document.sha256 }), { code: 'TAGGED_PDF_REMEDIATION_OUTPUT_INVALID' });
  assert.equal(tampered.observed.promoted, 0);

  const hostile = await fixture(t);
  const descriptor = planRequest(hostile.document);
  Object.defineProperty(descriptor, 'sourceSha256', { enumerable: true, get() { throw new Error('hostile descriptor'); } });
  await assert.rejects(hostile.service.update(hostile.document.id, descriptor, { sourceSha256: hostile.document.sha256 }), { code: 'INVALID_TAGGED_PDF_REMEDIATION_OPTIONS' });
  const proxied = new Proxy(planRequest(hostile.document), { ownKeys() { throw new Error('hostile ownKeys'); } });
  await assert.rejects(hostile.service.update(hostile.document.id, proxied, { sourceSha256: hostile.document.sha256 }), { code: 'INVALID_TAGGED_PDF_REMEDIATION_OPTIONS' });
  assert.equal(hostile.observed.promoted, 0);
});
