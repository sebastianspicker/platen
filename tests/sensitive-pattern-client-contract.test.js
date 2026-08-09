import assert from 'node:assert/strict';
import test from 'node:test';
import { createSensitivePatternEndpoints } from '../src/core/local-host-sensitive-pattern-endpoints.js';
import {
  PDF_SENSITIVE_PATTERN_LIMITATIONS,
  PDF_SENSITIVE_PATTERN_PROFILE,
  normalizePdfSensitivePatternRequest,
} from '../src/core/pdf-sensitive-pattern-contract.js';

const documentId = '123e4567-e89b-12d3-a456-426614174000';
const sourceSha256 = 'a'.repeat(64);

function request() {
  return {
    profile: PDF_SENSITIVE_PATTERN_PROFILE,
    sourceSha256,
    customPatterns: [{ label: 'SSN', pattern: '\\d{3}-\\d{2}-\\d{4}', regex: true }],
  };
}

function evidence() {
  return {
    sourceDigestReverified: true,
    sourceUnchanged: true,
    localOnly: true,
    textReturned: false,
    pathsReturned: false,
    bounded: true,
  };
}

function result(overrides = {}) {
  return {
    kind: 'pdf-sensitive-pattern-scan', profile: PDF_SENSITIVE_PATTERN_PROFILE, documentId, sourceSha256,
    pageCount: 2,
    matches: [{ id: 'match-1', page: 1, start: 4, end: 15, kind: 'custom-regex', label: 'SSN' }],
    matchCount: 1, truncated: false, evidence: evidence(), limitations: PDF_SENSITIVE_PATTERN_LIMITATIONS,
    ...overrides,
  };
}

function endpoints(response, calls = []) {
  return createSensitivePatternEndpoints({
    json(path, options) {
      calls.push({ path, options });
      return Promise.resolve(response);
    },
  });
}

test('sensitive-pattern endpoint normalizes the exact source-bound request and forwards AbortSignal', async () => {
  const calls = [];
  const controller = new AbortController();
  const value = await endpoints({ result: result() }, calls).findSensitivePatterns(documentId, request(), { signal: controller.signal });
  assert.equal(calls[0].path, `/api/documents/${documentId}/sensitive-patterns`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), request());
  assert.deepEqual(value, result());
});

test('sensitive-pattern request and response snapshots are immutable and detached', async () => {
  const originalRequest = request();
  const normalized = normalizePdfSensitivePatternRequest(originalRequest);
  originalRequest.customPatterns[0].label = 'changed';
  assert.equal(normalized.customPatterns[0].label, 'SSN');
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.customPatterns[0]), true);

  const body = { result: result() };
  const value = await endpoints(body).findSensitivePatterns(documentId, request());
  body.result.matches[0].label = 'changed';
  assert.equal(value.matches[0].label, 'SSN');
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.matches), true);
  assert.equal(Object.isFrozen(value.matches[0]), true);
  assert.throws(() => { value.matches[0].label = 'changed'; }, TypeError);
});

test('sensitive-pattern contract rejects hostile request graphs and unsafe regexes', async () => {
  const extra = { ...request(), extra: true };
  const symbol = request(); symbol[Symbol('unexpected')] = true;
  const accessor = request(); Object.defineProperty(accessor, 'sourceSha256', { enumerable: true, get() { throw new Error('must not read'); } });
  const proxy = new Proxy(request(), { ownKeys() { throw new Error('must not enumerate proxy'); } });
  const tooMany = { ...request(), customPatterns: Array.from({ length: 21 }, () => ({ label: 'x', pattern: 'x', regex: false })) };
  const unsafeRegex = { ...request(), customPatterns: [{ label: 'unsafe', pattern: '(a+)+', regex: true }] };
  const malformedLabel = { ...request(), customPatterns: [{ label: '/private/raw', pattern: 'x', regex: false }] };
  for (const value of [extra, symbol, accessor, proxy, tooMany, unsafeRegex, malformedLabel]) assert.throws(() => normalizePdfSensitivePatternRequest(value), TypeError);
  assert.throws(() => endpoints({ result: result() }).findSensitivePatterns('../escape', request()), TypeError);
});

test('sensitive-pattern client rejects forged, leaking, mismatched, and exaggerated results', async () => {
  const invalidResults = [
    result({ documentId: 'other-document' }),
    result({ matchCount: 2 }),
    result({ matches: [{ ...result().matches[0], text: '123-45-6789' }] }),
    result({ evidence: { ...evidence(), matchedTextReturned: true } }),
    result({ matches: [{ id: 'match-1', page: 1, start: 10, end: 11, kind: 'custom-regex', label: 'unknown' }] }),
    result({ matches: [{ id: 'match-1', page: 1, start: 10, end: 11, kind: 'custom-regex', label: '/private/raw' }] }),
  ];
  for (const invalid of invalidResults) await assert.rejects(endpoints({ result: invalid }).findSensitivePatterns(documentId, request()), TypeError);
  await assert.rejects(endpoints({ result: new Proxy(result(), { ownKeys() { throw new Error('must not enumerate'); } }) }).findSensitivePatterns(documentId, request()), TypeError);
  const accessor = result(); Object.defineProperty(accessor, 'sourceSha256', { enumerable: true, get() { throw new Error('must not read'); } });
  await assert.rejects(endpoints({ result: accessor }).findSensitivePatterns(documentId, request()), TypeError);
});
