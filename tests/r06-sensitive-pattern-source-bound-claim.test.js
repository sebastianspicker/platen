import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfSensitivePatternService } from '../scripts/host/pdf-sensitive-pattern-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { PDF_SENSITIVE_PATTERN_PROFILE } from '../src/core/pdf-sensitive-pattern-contract.js';
import { makeTextPdf } from './pdf-fixture.js';
import { invoke } from './support/host-router-fixture-base.js';

const TOKEN = 'a'.repeat(64);

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

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'platen-r06-sensitive-pattern-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const source = await store.createDocument({
    stream: Readable.from([makeTextPdf('Contact alice@example.com or +1 (415) 555-2671. Card 4111 1111 1111 1111.')]),
    displayName: 'sensitive-source.pdf',
  });
  const sensitivePatterns = new PdfSensitivePatternService({
    store,
    inspection: {
      async inspect() { return { pageCount: 1 }; },
      async extractText() { return [{ page: 1, text: 'Contact alice@example.com or +1 (415) 555-2671. Card 4111 1111 1111 1111.' }]; },
    },
  });
  const app = createAppHandler({
    staticHandler: () => {},
    store,
    service: { availability: async () => [] },
    workspaceState: {},
    sensitivePatterns,
    token: TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  return { app, client: new LocalHostClient({ fetchImpl: appFetch(app) }), source, store };
}

test('redaction.find-patterns performs one authenticated read-only source-bound scan without returning matched text', async (context) => {
  const state = await fixture(context);
  const sourcePath = state.store.getSourcePath(state.source.id);
  const before = await readFile(sourcePath);
  const request = {
    profile: PDF_SENSITIVE_PATTERN_PROFILE,
    sourceSha256: state.source.sha256,
    customPatterns: [{ label: 'Ticket', pattern: 'alice', regex: false }],
  };

  const unauthorized = await invoke(state.app, {
    method: 'POST',
    url: `/api/documents/${state.source.id}/sensitive-patterns`,
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  assert.equal(unauthorized.statusCode, 401);

  await state.client.bootstrap();
  const result = await state.client.findSensitivePatterns(state.source.id, request);
  assert.equal(result.kind, 'pdf-sensitive-pattern-scan');
  assert.equal(result.sourceSha256, state.source.sha256);
  assert.deepEqual(result.matches.map(({ kind }) => kind).sort(), ['custom-literal', 'email', 'payment-card', 'phone']);
  assert.deepEqual(result.evidence, {
    sourceDigestReverified: true,
    sourceUnchanged: true,
    localOnly: true,
    textReturned: false,
    pathsReturned: false,
    bounded: true,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /alice@example\.com|\+1 \(415\) 555-2671|4111 1111 1111 1111|sensitive-source\.pdf|\/private\//u,
  );
  assert.deepEqual(await readFile(sourcePath), before);
  assert.equal(await state.store.verifySource(state.source.id), true);
});
