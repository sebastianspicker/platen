import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PDF_ADVANCED_SEARCH_PROFILE } from '../scripts/host/pdf-advanced-search.mjs';
import { PdfAdvancedSearchService } from '../scripts/host/pdf-advanced-search-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';
import { makeTextPdf } from './pdf-fixture.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = createHash('sha256').update('viewer-advanced-search-claim').digest('hex');
const routeToken = 'a'.repeat(64);

function serviceFixture({ text = 'cat Cat cAt', digest = sourceSha256 } = {}) {
  const calls = {
    verify: 0,
    inspect: 0,
    extract: 0,
    search: 0,
  };
  const source = { id: documentId, sha256: digest, size: 42, displayName: 'viewer-advanced-search-claim.pdf' };
  const store = {
    getDocument() { return source; },
    async verifySource() { calls.verify += 1; },
  };
  const inspection = {
    async inspect() { calls.inspect += 1; return { pageCount: 1 }; },
    async extractText() { calls.extract += 1; return [{ page: 1, text }]; },
  };
  const inner = new PdfAdvancedSearchService({ store, inspection });
  return {
    calls,
    source,
    advancedSearch: {
      async search(...args) {
        calls.search += 1;
        return inner.search(...args);
      },
    },
  };
}

function createRouteFixture({ sourceText = 'cat Cat cAt', digest = sourceSha256 } = {}) {
  const { calls, source, advancedSearch } = serviceFixture({ text: sourceText, digest });
  const handler = createAppHandler({
    staticHandler: () => {},
    store: {
      deleteArtifact: async () => {},
      getDocument: () => source,
      verifySource: async () => { calls.verify += 1; },
    },
    service: { availability: async () => [] },
    workspaceState: {},
    advancedSearch,
    advancedSearchReady: true,
    token: routeToken,
    host: '127.0.0.1',
    port: 4173,
  });
  return { calls, source, handler };
}

function handlerFetch(handler) {
  return async (path, options = {}) => {
    const body = options.body ?? '';
    const lowercaseHeaders = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const response = await invoke(handler, {
      method: options.method ?? 'GET',
      url: path,
      headers: {
        origin: 'http://127.0.0.1:4173',
        ...lowercaseHeaders,
      },
      body,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    });
  };
}

function requestBody({ digest = sourceSha256, mode = 'literal', query = 'cat', caseSensitive = false, wholeWord = true } = {}) {
  return {
    profile: PDF_ADVANCED_SEARCH_PROFILE,
    sourceSha256: digest,
    query,
    mode,
    caseSensitive,
    wholeWord,
    context: 2,
    maxResults: 20,
  };
}

test('advanced-search service validates literal, wildcard, case-sensitive, and whole-word options against extracted text', async () => {
  const { source, advancedSearch } = serviceFixture();
  const options = Object.freeze({
    query: 'cat',
    mode: 'literal',
    caseSensitive: false,
    wholeWord: true,
    context: 2,
    maxResults: 20,
  });
  const insensitive = await advancedSearch.search(documentId, options, { sourceSha256: source.sha256 });
  const sensitive = await advancedSearch.search(documentId, { ...options, caseSensitive: true }, { sourceSha256: source.sha256 });
  const wildcard = await advancedSearch.search(documentId, { ...options, mode: 'wildcard', query: 'c?t', caseSensitive: false }, { sourceSha256: source.sha256 });
  assert.equal(insensitive.totalMatches, 3);
  assert.equal(sensitive.totalMatches, 1);
  assert.equal(wildcard.totalMatches, 3);
  assert.equal(insensitive.matches[0].text.toLowerCase(), 'cat');
});

test('advanced-search service binds results to one immutable retained DocumentStore source', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-viewer-advanced-search-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const source = await store.createDocument({
    stream: Readable.from([makeTextPdf('Retained search source')]),
    displayName: 'retained-search.pdf',
  });
  const inspection = {
    async inspect() { return { pageCount: 1 }; },
    async extractText() { return [{ page: 1, text: 'Retained search source' }]; },
  };
  const service = new PdfAdvancedSearchService({ store, inspection });
  const result = await service.search(source.id, {
    query: 'search',
    mode: 'literal',
    caseSensitive: true,
    wholeWord: true,
    context: 4,
    maxResults: 20,
  }, { sourceSha256: source.sha256 });
  assert.equal(result.sourceSha256, source.sha256);
  assert.equal(result.totalMatches, 1);
  assert.equal(result.matches[0].text, 'search');
});

test('advanced-search service rejects source drift and emits job-cancelled failure with no extract when pre-cancelled', async () => {
  const { source, advancedSearch } = serviceFixture();
  const base = {
    query: 'cat', mode: 'literal', caseSensitive: false, wholeWord: true, context: 2, maxResults: 20,
  };
  await assert.rejects(
    advancedSearch.search(documentId, base, { sourceSha256: '0'.repeat(64) }),
    { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
  );
  const controller = new AbortController();
  controller.abort(new Error('cancelled')); 
  await assert.rejects(
    advancedSearch.search(documentId, base, { sourceSha256: source.sha256, signal: controller.signal }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
});

test('advanced-search route chain requires auth before service execution and rejects wildcard-only query patterns before search', async () => {
  const { handler, calls, source } = createRouteFixture();
  const validRequest = requestBody({ digest: source.sha256 });
  const unauthorized = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/advanced-search`,
    headers: {
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
    },
    body: JSON.stringify(validRequest),
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls.search, 0);

  const wildcardOnly = requestBody({
    digest: source.sha256,
    mode: 'wildcard',
    query: '***',
  });
  const rejected = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/advanced-search`,
    headers: {
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
      'x-platen-token': routeToken,
    },
    body: JSON.stringify(wildcardOnly),
  });
  const rejectedBody = JSON.parse(rejected.body);
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejectedBody.error.code, 'INVALID_PDF_ADVANCED_SEARCH_OPTIONS');
  assert.equal(calls.search, 0);
});

test('advanced-search authenticated route and local-host client chain performs one-source extracted-text searching', async () => {
  const { handler, calls, source } = createRouteFixture({ sourceText: 'cat Cat cAt' });
  const client = new LocalHostClient({ fetchImpl: handlerFetch(handler) });
  await client.bootstrap();
  const response = await client.searchAdvancedText(documentId, {
    profile: PDF_ADVANCED_SEARCH_PROFILE,
    sourceSha256: source.sha256,
    query: 'C?t',
    mode: 'wildcard',
    caseSensitive: true,
    wholeWord: true,
    context: 2,
    maxResults: 20,
  });
  assert.equal(response.totalMatches, 1);
  assert.equal(calls.search, 1);
  assert.equal(response.matches[0].text, 'Cat');
});
