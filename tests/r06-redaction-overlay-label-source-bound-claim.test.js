import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfRedactionOverlayLabelService } from '../scripts/host/pdf-redaction-overlay-label-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { redactionFixture } from '../scripts/host/professional-capability/fixtures.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { REDACTION_OVERLAY_LABEL_PROFILE } from '../src/core/pdf-redaction-overlay-label-contract.js';
import { invoke } from './support/host-router-fixture-base.js';

const TOKEN = 'a'.repeat(64);

function appFetch(app) {
  return async (path, options = {}) => {
    const headers = { origin: 'http://127.0.0.1:4173', host: '127.0.0.1:4173' };
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key.toLowerCase()] = value;
    headers['x-platen-token'] = TOKEN;
    const response = await invoke(app, { method: options.method ?? 'GET', url: path, headers, body: options.body ?? '' });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r06-overlay-label-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourceBytes = redactionFixture({ secret: 'secret', survivor: 'survivor' });
  const source = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'overlay-source.pdf' });
  const redactionOverlayLabels = new PdfRedactionOverlayLabelService({ store });
  const app = createAppHandler({
    staticHandler: () => {}, store, service: { availability: async () => [] }, workspaceState: {},
    redactionOverlayLabels, token: TOKEN, host: '127.0.0.1', port: 4173,
  });
  return { app, client: new LocalHostClient({ fetchImpl: appFetch(app) }), source, sourceBytes, store };
}

test('redaction.overlay-labels creates one authenticated source-bound full-page redaction artifact with one bounded label annotation', async (context) => {
  const state = await fixture(context);
  const sourcePath = state.store.getSourcePath(state.source.id);
  const before = await readFile(sourcePath);
  const request = {
    profile: REDACTION_OVERLAY_LABEL_PROFILE,
    sourceSha256: state.source.sha256,
    page: 1,
    label: 'PUBLIC',
  };

  const unauthorized = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.source.id}/redaction-overlay-label`,
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  assert.equal(unauthorized.statusCode, 401);

  await state.client.bootstrap();
  const result = await state.client.applyRedactionOverlayLabel(state.source.id, request);
  assert.equal(result.kind, 'pdf-redaction-overlay-label');
  assert.equal(result.sourceSha256, state.source.sha256);
  assert.equal(result.page, 1);
  assert.equal(result.label, 'PUBLIC');
  assert.equal(result.artifact.documentId, state.source.id);
  assert.notEqual(result.artifact.id, state.source.id);
  assert.deepEqual(Object.values(result.evidence), Array(8).fill(true));
  assert.equal('pdf' in result, false);
  assert.equal('bytes' in result, false);
  assert.equal('filePath' in result.artifact, false);

  const artifact = await invoke(state.app, {
    method: 'GET', url: `/api/artifacts/${result.artifact.id}`,
    headers: { origin: 'http://127.0.0.1:4173', 'x-platen-token': TOKEN },
  });
  assert.equal(artifact.statusCode, 200);
  assert.equal(artifact.body.length, result.artifact.size);
  assert.equal(artifact.body.includes(Buffer.from('secret', 'latin1')), false);
  assert.equal(artifact.body.subarray(0, state.sourceBytes.length).equals(state.sourceBytes), false);
  assert.deepEqual(await readFile(sourcePath), before);
  assert.equal(await state.store.verifySource(state.source.id), true);
});
