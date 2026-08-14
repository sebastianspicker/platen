import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { HostError } from '../scripts/host/host-error.mjs';
import { handleSensitivePatternRoute } from '../scripts/host/routes/sensitive-pattern-routes.mjs';
import {
  PDF_SENSITIVE_PATTERN_LIMITATIONS,
  PDF_SENSITIVE_PATTERN_PROFILE,
} from '../src/core/pdf-sensitive-pattern-contract.js';

const body = Object.freeze({
  profile: PDF_SENSITIVE_PATTERN_PROFILE,
  sourceSha256: 'a'.repeat(64),
  customPatterns: Object.freeze([{ label: 'Client', pattern: 'ALPHA', regex: false }]),
});

function result(documentId = 'doc') {
  return {
    kind: 'pdf-sensitive-pattern-scan',
    profile: PDF_SENSITIVE_PATTERN_PROFILE,
    documentId,
    sourceSha256: body.sourceSha256,
    pageCount: 1,
    matches: [{ id: 'match-1', page: 1, start: 0, end: 3, kind: 'email', label: 'Email' }],
    matchCount: 1,
    truncated: false,
    evidence: {
      sourceDigestReverified: true,
      sourceUnchanged: true,
      localOnly: true,
      textReturned: false,
      pathsReturned: false,
      bounded: true,
    },
    limitations: PDF_SENSITIVE_PATTERN_LIMITATIONS,
  };
}

function context({ operation = 'sensitive-patterns', service = true, query = '', read = body, method = 'POST' } = {}) {
  const response = new EventEmitter();
  const controller = new AbortController();
  const calls = [];
  return {
    request: { method },
    response,
    url: new URL(`http://local/api/documents/doc/sensitive-patterns${query}`),
    documentId: 'doc',
    operation,
    processing: { signal: controller.signal },
    sensitivePatterns: service ? {
      find: async (...args) => {
        calls.push(args);
        return result();
      },
    } : null,
    bodyLimit: 1024,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => read,
    json: (_response, status, value) => { response.status = status; response.value = value; },
    calls,
    controller,
  };
}

test('sensitive-pattern route forwards the normalized request and returns validated read-only evidence', async () => {
  const value = context();
  assert.equal(await handleSensitivePatternRoute(value), true);
  assert.equal(value.response.status, 200);
  assert.deepEqual(value.response.value, { result: result() });
  assert.equal(value.calls.length, 1);
  assert.equal(value.calls[0][0], 'doc');
  assert.deepEqual(value.calls[0][1], body);
  assert.equal(value.calls[0][2].signal, value.processing.signal);
});

test('sensitive-pattern route requires the exact method, body, and no query parameters', async () => {
  const value = context({ method: 'GET' });
  await assert.rejects(handleSensitivePatternRoute(value), /Expected values to be strictly equal/);
  await assert.rejects(handleSensitivePatternRoute(context({ query: '?page=1' })), { code: 'INVALID_PARAMETER', status: 400 });
  for (const invalid of [
    { ...body, extra: true },
    { ...body, profile: 'other' },
    { ...body, sourceSha256: body.sourceSha256.toUpperCase() },
    { ...body, customPatterns: [{ label: 'bad', pattern: '(a+)+$', regex: true }] },
  ]) {
    await assert.rejects(handleSensitivePatternRoute(context({ read: invalid })), { code: 'INVALID_PDF_SENSITIVE_PATTERN_OPTIONS', status: 400 });
  }
});

test('sensitive-pattern route fails closed when unavailable, forwards cancellation, and rejects forged or leaky results', async () => {
  await assert.rejects(handleSensitivePatternRoute(context({ service: false })), { code: 'PDF_SENSITIVE_PATTERN_UNAVAILABLE', status: 503 });

  const cancelled = context();
  cancelled.controller.abort();
  cancelled.sensitivePatterns.find = async (_documentId, _request, options) => {
    assert.equal(options.signal, cancelled.processing.signal);
    const error = new Error('cancelled');
    error.code = 'JOB_CANCELLED';
    throw error;
  };
  await assert.rejects(handleSensitivePatternRoute(cancelled), { code: 'JOB_CANCELLED' });

  const stale = context();
  stale.sensitivePatterns.find = async () => {
    throw new HostError('SOURCE_VERSION_MISMATCH', 'source changed', 409);
  };
  await assert.rejects(handleSensitivePatternRoute(stale), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });

  for (const forged of [
    { ...result(), documentId: 'other' },
    { ...result(), paths: ['/private/source.pdf'] },
    { ...result(), evidence: { ...result().evidence, pathsReturned: true } },
  ]) {
    const value = context();
    value.sensitivePatterns.find = async () => forged;
    await assert.rejects(handleSensitivePatternRoute(value), { code: 'PDF_SENSITIVE_PATTERN_OUTPUT_INVALID', status: 502 });
  }
});

test('sensitive-pattern route rejects hostile request accessors as malformed options', async () => {
  const hostile = new Proxy({}, {
    ownKeys() { throw new Error('poisoned keys'); },
    get() { throw new Error('poisoned property'); },
  });
  await assert.rejects(handleSensitivePatternRoute(context({ read: hostile })), { code: 'INVALID_PDF_SENSITIVE_PATTERN_OPTIONS', status: 400 });
});
