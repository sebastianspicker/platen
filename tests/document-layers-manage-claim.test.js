import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runLayerDefaultsCommand } from '../scripts/cli/commands/layer-defaults.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PDF_LAYER_DEFAULTS_PROFILE } from '../scripts/host/pdf-layer-defaults-contract.mjs';
import { PdfLayerDefaultsService } from '../scripts/host/pdf-layer-defaults-service.mjs';
import { inspectPdfLayerDefaults } from '../scripts/host/pdf-layer-defaults-writer.mjs';
import { handleLayerDefaultsRoute } from '../scripts/host/routes/layer-defaults-routes.mjs';

function sourceFixture() {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const object = (number, body, stream = null) => {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\n`);
    if (stream !== null) chunks.push(`stream\n${stream}endstream\n`);
    chunks.push('endobj\n');
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R 8 0 R] /D << /BaseState /ON >> >> >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /CropBox [0 0 300 400] /Resources << /Properties << /L1 7 0 R /L2 8 0 R >> >> /Contents 5 0 R >>');
  object(5, '<< /Length 4 >>', 'q\nQ\n');
  object(7, '<< /Type /OCG /Name (Layer one) /Intent /View >>');
  object(8, '<< /Type /OCG /Name (Layer two) /Intent /View >>');
  const body = chunks.join(''); const xrefOffset = Buffer.byteLength(body, 'latin1');
  let xref = 'xref\n0 9\n0000000000 65535 f \n';
  for (let number = 1; number < 9; number += 1) {
    const offset = offsets.get(number);
    xref += offset === undefined ? '0000000000 00000 f \n' : `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  return Buffer.from(`${body}${xref}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'document-layers-manage-claim-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourceBytes = sourceFixture();
  const document = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'source.pdf', mediaType: 'application/pdf' });
  return { root, store, sourceBytes, document, service: new PdfLayerDefaultsService({ store }) };
}

test('document.layers-manage bounded claim changes only ordered existing passive OCG visibility', async (t) => {
  const value = await setup(t);
  const request = { profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256: value.document.sha256, changes: [{ groupIndex: 1, visible: false }] };
  const result = await value.service.update(value.document.id, request, { sourceSha256: value.document.sha256 });
  const retained = value.store.getArtifact(result.artifact.id);
  const output = await readFile(retained.filePath);
  const proof = inspectPdfLayerDefaults(value.sourceBytes, output, request);
  assert.equal(result.kind, 'pdf-layer-defaults');
  assert.equal(result.sourceDigest, value.document.sha256);
  assert.equal(result.artifact.documentId, value.document.id);
  assert.equal(result.artifact.sha256, createHash('sha256').update(output).digest('hex'));
  assert.notEqual(result.artifact.sha256, value.document.sha256);
  assert.equal(result.evidence.sourcePrefixPreserved, true);
  assert.equal(result.evidence.onlyCatalogChanged, true);
  assert.equal(result.evidence.classicIncrementalRevisionAppended, true);
  assert.deepEqual(proof.visible, [true, false]);
  assert.equal(proof.groupCount, 2);
  assert.equal(output.subarray(0, value.sourceBytes.length).equals(value.sourceBytes), true);
  assert.deepEqual({ ...result.artifact.operation.parameters }, {
    groupCount: 2, visibleGroupIndices: [0], hiddenGroupIndices: [1],
  });
  assert.equal(Object.hasOwn(result.artifact.operation.parameters, 'name'), false);
  assert.equal(Object.hasOwn(result.artifact.operation.parameters, 'assign'), false);
  assert.equal(Object.hasOwn(result.artifact.operation.parameters, 'order'), false);
  assert.equal(await value.store.verifySource(value.document.id), true);
  assert.deepEqual(await readdir(join(value.root, 'jobs')), []);
  await value.store.deleteArtifact(result.artifact.id);
});

test('document.layers-manage route binds the existing source-bound visibility contract', async () => {
  const response = new EventEmitter(); const calls = [];
  const sourceSha256 = 'a'.repeat(64);
  const context = {
    request: { method: 'POST' }, response,
    url: new URL('http://local.test/api/documents/doc/layer-defaults'),
    documentId: 'doc', operation: 'layer-defaults', processing: { signal: new AbortController().signal },
    layerDefaults: { update: async (...args) => { calls.push(args); return { kind: 'pdf-layer-defaults', artifact: { id: 'artifact-1' } }; } },
    store: { deleteArtifact: async () => {} }, bodyLimit: 4096,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => ({ profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256, changes: [{ groupIndex: 0, visible: false }] }),
    json: (_response, status, value) => { response.status = status; response.value = value; },
  };
  assert.equal(await handleLayerDefaultsRoute(context), true);
  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'doc');
  assert.deepEqual(calls[0][1], { profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256, changes: [{ groupIndex: 0, visible: false }] });
  assert.equal(calls[0][2].sourceSha256, sourceSha256);
  assert(calls[0][2].signal instanceof AbortSignal);
});

test('document.layers-manage CLI publishes and consumes the retained visibility artifact', async (t) => {
  const value = await setup(t); const emitted = []; let copied = null; const deleted = [];
  const application = {
    layerDefaults: value.service,
    store: {
      getArtifact: (id) => value.store.getArtifact(id),
      deleteArtifact: async (id) => { deleted.push(id); await value.store.deleteArtifact(id); },
    },
  };
  const signal = new AbortController().signal;
  await runLayerDefaultsCommand(application, { changes: [{ groupIndex: 1, visible: false }], output: '/tmp/layers.pdf' }, value.document, null, signal, {
    cancelled: () => {},
    canonicalOutputTarget: async () => {},
    copyExclusive: async (sourcePath, outputPath, receivedSignal) => {
      copied = { bytes: await readFile(sourcePath), outputPath, receivedSignal };
    },
    emit: async (_stdout, receipt) => emitted.push(receipt),
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  });
  assert.equal(copied.outputPath, '/tmp/layers.pdf');
  assert.equal(copied.receivedSignal, signal);
  assert.equal(copied.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].proof.onlyCatalogChanged, true);
  assert.equal(emitted[0].proof.sourcePrefixPreserved, true);
  assert.equal(Object.hasOwn(emitted[0], 'sourceDigest'), false);
  assert.equal(Object.hasOwn(emitted[0].artifact, 'operation'), false);
  assert.equal(Object.hasOwn(emitted[0].artifact, 'filePath'), false);
  assert.deepEqual(deleted, [emitted[0].artifact.id]);
});

test('document.layers-manage cancellation cleans private work and leaves the source unchanged', async (t) => {
  const value = await setup(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    value.service.update(value.document.id, {
      profile: PDF_LAYER_DEFAULTS_PROFILE,
      sourceSha256: value.document.sha256,
      changes: [{ groupIndex: 1, visible: false }],
    }, { sourceSha256: value.document.sha256, signal: controller.signal }),
    { code: 'JOB_CANCELLED' },
  );
  assert.equal(await value.store.verifySource(value.document.id), true);
  assert.deepEqual(await readdir(join(value.root, 'jobs')), []);
});
