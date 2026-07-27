import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handlePageBackgroundRoute } from '../scripts/host/routes/page-background-routes.mjs';
import { createPageBackgroundEndpoints } from '../src/core/local-host-page-background-endpoints.js';
import { PDF_PAGE_BACKGROUND_LIMITATIONS, PDF_PAGE_BACKGROUND_PROFILE, PDF_PAGE_BACKGROUND_VALIDATORS, validatePageBackgroundResult } from '../src/core/pdf-page-background-contract.js';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runPageBackgroundCommand } from '../scripts/cli/commands/page-background.mjs';
import { createLocalApplication } from '../scripts/local-host.mjs';

const sourceSha256 = 'a'.repeat(64);
const body = { profile: 'local-classic-solid-page-background-v1', sourceSha256, pages: [1, 3], color: { r: 0.1, g: 0.2, b: 0.3 } };

test('page-background route enforces exact body and delegates authenticated work', async () => {
  const response = new EventEmitter();
response.destroyed = false;
const observed = {};
const context = { operation: 'page-background', request: {}, response, url: new URL('http://127.0.0.1/api/documents/doc/page-background'), documentId: 'doc', processing: { signal: new AbortController().signal }, pageBackground: { create: async (...args) => { observed.args = args;
return { artifact: { id: 'artifact' } };
} }, bodyLimit: 4096, exactJsonObject: (value, keys) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key)), method: () => {}, readJson: async () => body, json: (_response, status, value) => { observed.status = status;
observed.value = value;
}, store: { deleteArtifact: async () => {} } };
  assert.equal(await handlePageBackgroundRoute(context), true);
assert.equal(observed.status, 201);
assert.equal(observed.args[1].color.g, 0.2);
});

test('page-background route and client reject malformed colors', async () => {
  const response = new EventEmitter();
response.destroyed = false;
const bad = { ...body, color: { r: 2, g: 0, b: 0 } };
const context = { operation: 'page-background', request: {}, response, url: new URL('http://127.0.0.1/api/documents/doc/page-background'), documentId: 'doc', processing: { signal: new AbortController().signal }, pageBackground: { create: async () => { throw new Error('must not run');
} }, bodyLimit: 4096, exactJsonObject: (value, keys) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key)), method: () => {}, readJson: async () => bad, json: () => {}, store: { deleteArtifact: async () => {} } };
  await assert.rejects(handlePageBackgroundRoute(context), { code: 'PAGE_BACKGROUND_OPTIONS_INVALID', status: 400 });
  const endpoints = createPageBackgroundEndpoints({ json: async () => { throw new Error('must not call transport');
} });
await assert.rejects(Promise.resolve().then(() => endpoints.createPageBackground('doc', sourceSha256, { pages: [1], color: { r: 2, g: 0, b: 0 } })), TypeError);
});

test('page-background CLI parses strict pages and RGB values', () => {
  const command = parseCliArguments(['page-background', 'input.pdf', '--pages', '1,3-4', '--color', '0.1,0.2,1', '--output', 'output.pdf']);
assert.deepEqual(command.pages, [1, 3, 4]);
assert.deepEqual(command.color, { r: 0.1, g: 0.2, b: 1 });
  assert.throws(() => parseCliArguments(['page-background', 'input.pdf', '--pages', '1', '--color', '1.000001,0,0', '--output', 'output.pdf']), { code: 'CLI_INVALID_OPTION' });
});

function validResult() {
  const documentId = '11111111-1111-4111-8111-111111111111';
  const sourceDigest = 'a'.repeat(64);
const outputDigest = 'b'.repeat(64);
const color = { r: 0.1, g: 0.2, b: 0.3 };
const stream = { reference: '8 0 R', bytes: 36, sha256: 'c'.repeat(64) };
  const page = { page: 1, reference: '4 0 R', mediaBox: [0, 0, 612, 792], cropBox: [0, 0, 612, 792], color, stream, foundationEdit: { index: 0, page: 1, position: 'prepend', reference: '8 0 R', objectNumber: 8, generation: 0, bytes: 36, sha256: stream.sha256, tokenCount: 12, operatorCounts: { f: 1, q: 1, Q: 1, re: 1, rg: 1 } } };
  const operation = { schemaVersion: 1, id: '33333333-3333-4333-8333-333333333333', type: 'pdf-solid-page-background', inputs: [{ documentId, sha256: sourceDigest, role: 'source' }], parameters: { profile: PDF_PAGE_BACKGROUND_PROFILE, pages: [1], color }, expected: { sourcePrefixPreserved: true, outputSha256: outputDigest }, validation: { passed: true, validators: [...PDF_PAGE_BACKGROUND_VALIDATORS], outputSha256: outputDigest }, completedAt: '2026-01-01T00:00:00.000Z' };
  return { result: { kind: 'pdf-solid-page-background', sourceDigest, artifact: { id: '22222222-2222-4222-8222-222222222222', documentId, displayName: 'page-background.pdf', mediaType: 'application/pdf', size: 100, sha256: outputDigest, operation, createdAt: '2026-01-01T00:00:00.000Z' }, pages: [page], evidence: { sourcePrefixPreserved: true, outputDigestBound: true, sourceUnchanged: true, onlySelectedPagesChanged: true, pageBoxesUnchanged: true, resourcesUnchanged: true, annotationsUnchanged: true, localOnly: true }, limitations: [...PDF_PAGE_BACKGROUND_LIMITATIONS] }, documentId, sourceDigest, request: { pages: [1], color } };
}

test('page-background client validates a real-shaped result, freezes it, and rejects digest/timestamp tampering', () => {
  const fixture = validResult();
const context = { documentId: fixture.documentId, sourceSha256: fixture.sourceDigest, request: fixture.request };
const validated = validatePageBackgroundResult(JSON.parse(JSON.stringify(fixture.result)), context);
assert.equal(validated.artifact.sha256, 'b'.repeat(64));
assert.throws(() => { validated.pages[0].color.r = 0.9;
}, TypeError);
const badDigest = JSON.parse(JSON.stringify(fixture.result));
badDigest.artifact.sha256 = 'd'.repeat(64);
assert.throws(() => validatePageBackgroundResult(badDigest, context), { code: 'INVALID_LOCAL_HOST' });
const badTimestamp = JSON.parse(JSON.stringify(fixture.result));
badTimestamp.artifact.createdAt = '2026-01-01';
assert.throws(() => validatePageBackgroundResult(badTimestamp, context), { code: 'INVALID_LOCAL_HOST' });
});

test('page-background endpoint sends the exact authenticated request and validates the returned graph', async () => {
  const fixture = validResult(); const controller = new AbortController(); let observed = null; const endpoint = createPageBackgroundEndpoints({ json: async (path, options) => { observed = { path, options }; return { result: JSON.parse(JSON.stringify(fixture.result)) }; } }); const result = await endpoint.createPageBackground(fixture.documentId, fixture.sourceDigest, fixture.request, { signal: controller.signal }); assert.equal(observed.path, `/api/documents/${fixture.documentId}/page-background`); assert.equal(observed.options.method, 'POST'); assert.equal(JSON.parse(observed.options.body).color.g, 0.2); assert.equal(observed.options.signal, controller.signal); assert.throws(() => { result.pages[0].page = 4; }, TypeError);
  const tampered = createPageBackgroundEndpoints({ json: async () => { const value = JSON.parse(JSON.stringify(fixture.result)); value.artifact.operation.expected.outputSha256 = 'd'.repeat(64); return { result: value }; } }); await assert.rejects(tampered.createPageBackground(fixture.documentId, fixture.sourceDigest, fixture.request), { code: 'INVALID_LOCAL_HOST' });
});

test('page-background CLI executes copy with cancellation and revokes the promoted artifact', async () => {
  const controller = new AbortController();
let copiedSignal = null;
let deleted = 0;
const application = { pageBackground: { create: async () => ({ artifact: { id: 'artifact', filePath: '/tmp/input.pdf' } }) }, store: { getArtifact: () => ({ filePath: '/tmp/input.pdf' }), deleteArtifact: async () => { deleted += 1;
} } };
const runtime = { cancelled: (signal) => { if (signal.aborted) { const error = new Error('cancelled');
error.code = 'JOB_CANCELLED';
throw error;
} }, canonicalOutputTarget: async () => {}, copyExclusive: async (_source, _target, signal) => { copiedSignal = signal;
controller.abort(new Error('cancelled'));
}, emit: async () => {}, fail: () => { throw new Error('unavailable');
} };
const command = { command: 'page-background', output: '/tmp/output.pdf', pages: [1], color: { r: 0, g: 0, b: 0 } };
await assert.rejects(runPageBackgroundCommand(application, command, { id: 'doc', sha256: sourceSha256 }, {}, controller.signal, runtime), { code: 'JOB_CANCELLED' });
assert.equal(copiedSignal, controller.signal);
assert.equal(deleted, 1);
});

test('page-background route rejects query parameters, method failures, and extra body keys', async () => {
  const response = new EventEmitter();
response.destroyed = false;
const base = { operation: 'page-background', request: {}, response, documentId: 'doc', processing: { signal: new AbortController().signal }, pageBackground: { create: async () => ({ artifact: { id: 'artifact' } }) }, bodyLimit: 4096, exactJsonObject: (value, keys) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key)), readJson: async () => body, json: () => {}, store: { deleteArtifact: async () => {} } };
await assert.rejects(handlePageBackgroundRoute({ ...base, url: new URL('http://127.0.0.1/api/documents/doc/page-background?x=1'), method: () => {} }), { code: 'INVALID_PARAMETER' });
await assert.rejects(handlePageBackgroundRoute({ ...base, url: new URL('http://127.0.0.1/api/documents/doc/page-background'), method: () => { throw Object.assign(new Error('GET'), { code: 'METHOD_NOT_ALLOWED', status: 405 });
} }), { code: 'METHOD_NOT_ALLOWED' });
await assert.rejects(handlePageBackgroundRoute({ ...base, url: new URL('http://127.0.0.1/api/documents/doc/page-background'), method: () => {}, readJson: async () => ({ ...body, extra: true }) }), { code: 'PAGE_BACKGROUND_OPTIONS_INVALID', status: 400 });
});

test('local application composes the page-background service facade', async () => {
  const application = await createLocalApplication({ root: process.cwd(), token: 'c'.repeat(64) });
try { assert.equal(typeof application.pageBackground?.create, 'function');
} finally { await application.close();
}
});
