import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleAcroFormSignatureFieldRoute } from '../scripts/host/routes/acroform-routes.mjs';
import { createAcroFormSignatureFieldEndpoints } from '../src/core/local-host-acroform-signature-field-endpoints.js';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runAcroFormSignatureFieldCommand } from '../scripts/cli/commands/acroform.mjs';
import { PdfAcroFormSignatureFieldService } from '../scripts/host/pdf-acroform-signature-field-service.mjs';

const digest = 'a'.repeat(64);
const documentId = '123e4567-e89b-12d3-a456-426614174000';
const rect = { x: 1, y: 2, width: 10, height: 10 };
function result(request) { const outputSha256 = 'b'.repeat(64);
const operation = { schemaVersion: 1, id: '123e4567-e89b-42d3-a456-426614174001', type: 'pdf-acroform-signature-field', inputs: [{ documentId, sha256: digest, role: 'source' }], parameters: { profile: request.profile, fieldNameSha256: 'c'.repeat(64), page: request.page, rect: request.rect }, expected: { outputSha256, sourcePrefixPreserved: true, emptyUnsigned: true, signingPerformed: false }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'bounded-acroform-signature-field-core', 'independent-signature-field-reinspection', 'output-sha256'], outputSha256 }, completedAt: '2026-07-20T00:00:00.000Z' };
return { artifact: { id: '123e4567-e89b-42d3-a456-426614174002', documentId, displayName: 'signature-field-form.pdf', mediaType: 'application/pdf', size: 100, sha256: outputSha256, operation, createdAt: '2026-07-20T00:00:00.000Z' }, proof: { profile: request.profile, sourceSha256: digest, page: request.page, fieldNameSha256: operation.parameters.fieldNameSha256, rect: request.rect, sourcePrefixPreserved: true, emptyUnsigned: true, objectCount: 2, references: { widget: { object: 5, generation: 0 }, acroForm: { object: 6, generation: 0 } }, otherPagesContentResourcesPreserved: true }, limitations: ['One empty passive terminal signature field only; no signing, certificate, key custody, appearance, timestamp, identity, or LTV operation is performed.', 'Existing forms, widgets, signatures, encryption, tags, layers, actions, JavaScript, calculations, XFA, rotation, and unsupported PDF graphs are rejected.'] };
}

test('signature-field route enforces method/query/body boundaries', async () => { const response = new EventEmitter();
const body = { profile: 'local-pdf-acroform-signature-field-v1', sourceSha256: digest, page: 1, fieldName: 'Sign.Here', rect };
const calls = [];
const context = { request: { method: 'POST' }, response, url: new URL(`http://local/api/documents/${documentId}/acroform-signature-field`), documentId, operation: 'acroform-signature-field', processing: { signal: new AbortController().signal }, store: {}, acroFormSignatureField: { add: async (...args) => { calls.push(args);
return { artifact: { id: 'artifact' }, limitations: [] };
} }, exactJsonObject: (value, keys) => Boolean(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), method: (request, expected) => assert.equal(request.method, expected), readJson: async () => body, json: (_response, status, value) => { response.status = status;
response.value = value;
} };
assert.equal(await handleAcroFormSignatureFieldRoute(context), true);
assert.equal(response.status, 201);
assert.equal(calls[0][1].sourceSha256, digest);
const query = { ...context, url: new URL(`${context.url}?extra=1`) };
await assert.rejects(handleAcroFormSignatureFieldRoute(query), { code: 'INVALID_PARAMETER' });
});
test('signature-field client validates provenance, refs, limitations, and freezes result', async () => { const request = { profile: 'local-pdf-acroform-signature-field-v1', sourceSha256: digest, page: 1, fieldName: 'Sign.Here', rect };
const calls = [];
const endpoint = createAcroFormSignatureFieldEndpoints({ json: async (path, options) => { calls.push({ path, options });
return { result: result(request) };
} });
const checked = await endpoint.addAcroFormSignatureField(documentId, request);
assert.equal(calls[0].path, `/api/documents/${documentId}/acroform-signature-field`);
assert.equal(Object.isFrozen(checked), true);
assert.equal(Object.isFrozen(checked.artifact.operation.validation.validators), true);
});
test('signature-field CLI parser and command bind source, signal, exclusive output, and local-only result', async () => { assert.deepEqual(parseCliArguments(['acroform-signature-field', 'input.pdf', '--page', '1', '--field', 'Sign.Here', '--rect', '1,2,10,10', '--output', 'out.pdf']), { command: 'acroform-signature-field', input: 'input.pdf', fieldName: 'Sign.Here', page: 1, rect, output: 'out.pdf' });
const calls = [];
const copied = [];
const emitted = [];
const application = { acroFormSignatureField: { add: async (...args) => { calls.push(args);
return { artifact: { id: 'a' }, proof: {}, limitations: [] };
} }, store: { getArtifact: () => ({ filePath: 'a.pdf' }) } };
const runtime = { cancelled: () => {}, copyExclusive: async (...args) => copied.push(args), emit: async (_stdout, value) => emitted.push(value) };
const signal = new AbortController().signal;
await runAcroFormSignatureFieldCommand(application, { command: 'acroform-signature-field', page: 1, fieldName: 'Sign.Here', rect, output: 'out.pdf' }, { id: documentId, sha256: digest }, null, signal, runtime);
assert.equal(calls[0][1].sourceSha256, digest);
assert.equal(calls[0][2].signal, signal);
assert.equal(copied.length, 1);
assert.equal(emitted.length, 1);
});

test('signature-field client rejects noncanonical operation identity, timestamp, refs, and proof hash', async () => {
  const request = { profile: 'local-pdf-acroform-signature-field-v1', sourceSha256: digest, page: 1, fieldName: 'Sign.Here', rect };
  for (const mutate of [
    (value) => { value.artifact.operation.id = 'not-a-uuid'; },
    (value) => { value.artifact.operation.completedAt = '2026-07-20T00:00:00Z'; },
    (value) => { value.proof.references.widget.generation = 1; },
    (value) => { value.proof.fieldNameSha256 = 'd'.repeat(64); },
  ]) {
    const bad = result(request);
    mutate(bad);
    const endpoint = createAcroFormSignatureFieldEndpoints({ json: async () => ({ result: bad }) });
    await assert.rejects(endpoint.addAcroFormSignatureField(documentId, request), /invalid/i);
  }
});

test('signature-field CLI revokes artifact when cancellation arrives during output copy', async () => {
  let deleted = null;
  const application = {
    acroFormSignatureField: { add: async () => ({ artifact: { id: 'artifact' }, proof: {}, limitations: [] }) },
    store: { getArtifact: () => ({ filePath: 'artifact.pdf' }), deleteArtifact: async (id) => { deleted = id; } },
  };
  const controller = new AbortController();
  const runtime = {
    cancelled: (signal) => { if (signal.aborted) { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; throw error; } },
    copyExclusive: async (_source, _target, signal) => { assert.equal(signal, controller.signal); controller.abort(); },
    emit: async () => { throw new Error('must not emit'); },
  };
  await assert.rejects(runAcroFormSignatureFieldCommand(application, { command: 'acroform-signature-field', page: 1, fieldName: 'Sign.Here', rect, output: 'out.pdf' }, { id: documentId, sha256: digest }, null, controller.signal, runtime), { code: 'JOB_CANCELLED' });
  assert.equal(deleted, 'artifact');
});

test('signature-field service is directly importable and composes from the shared store contract', () => {
  const methods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'];
  const store = Object.fromEntries(methods.map((name) => [name, () => {}]));
  assert.ok(new PdfAcroFormSignatureFieldService({ store }));
});

test('signature-field client rejects overprecision and negative-zero rectangles', () => {
  const endpoint = createAcroFormSignatureFieldEndpoints({ json: async () => ({ result: null }) });
  const base = { profile: 'local-pdf-acroform-signature-field-v1', sourceSha256: digest, page: 1, fieldName: 'Sign.Here' };
  assert.throws(() => endpoint.addAcroFormSignatureField(documentId, { ...base, rect: { ...rect, x: 1.0000001 } }), TypeError);
  assert.throws(() => endpoint.addAcroFormSignatureField(documentId, { ...base, rect: { ...rect, x: -0 } }), TypeError);
});
