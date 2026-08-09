import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import test from 'node:test';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { OPTIMIZE_VALIDATORS } from '../scripts/host/conversion-optimize-export.mjs';
import { runOptimizeCompressCommand } from '../scripts/cli/commands/optimize-compress.mjs';

const sourceId = '11111111-1111-4111-8111-111111111111';
const derivedId = '22222222-2222-4222-8222-222222222222';

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    value: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
  };
}

function fixture({ forged = false, evidence = {}, writer = null } = {}) {
  const sourceBytes = createTextPdf({ text: 'Alpha', title: 'Source' });
  const outputBytes = createTextPdf({ text: 'Alpha', title: 'Optimized' });
  const source = Object.freeze({ id: sourceId, sha256: createHash('sha256').update(sourceBytes).digest('hex'), size: sourceBytes.length, mediaType: 'application/pdf' });
  const textSha256 = createHash('sha256').update('Alpha').digest('hex');
  const operation = createOperationProvenance({
    type: 'optimize-pdf', inputs: [{ documentId: sourceId, sha256: source.sha256, role: 'primary' }],
    parameters: { mode: 'optimize' }, expected: { pageCount: 1 },
    validation: { passed: true, validators: forged ? ['source-sha256', 'fallback', 'pdfinfo-page-count'] : OPTIMIZE_VALIDATORS, pageCount: 1 },
  });
  const derived = Object.freeze({ id: derivedId, origin: 'derived', mediaType: 'application/pdf', size: outputBytes.length, sha256: createHash('sha256').update(outputBytes).digest('hex'), operation });
  const state = { deleted: [], emitted: 0 };
  const output = capture();
  const app = {
    conversion: {
      async rewriteDocument() { return derived; },
      async prepareOptimizePdfExport() {
        return {
          bytes: outputBytes, sourceDigest: source.sha256, outputDigest: derived.sha256,
          sourceSize: source.size, outputSize: derived.size, savedBytes: source.size - derived.size,
          reduced: true, pageCount: 1, pageGeometry: [{ page: 1, widthPoints: 612, heightPoints: 792 }],
          sourcePageGeometry: [{ page: 1, widthPoints: 612, heightPoints: 792 }],
          textPages: [{ page: 1, text: 'Alpha' }], sourceTextPages: [{ page: 1, text: 'Alpha' }],
          sourceTextDigest: textSha256, outputTextDigest: textSha256, textBytes: 5,
          geometryPreserved: true, textPreserved: true,
          passiveIndicators: { encrypted: 'no', javascript: 'no', form: 'none' }, ...evidence,
        };
      },
    },
    store: {
      getDocument(id) { assert.equal(id, derivedId); return derived; },
      async deleteDocument(id) { state.deleted.push(id); },
    },
  };
  const runtime = {
    cancelled() {}, canonicalOutputTarget: async () => {},
    writeExclusiveVerified: writer ?? (async (_path, bytes, _signal, finalize) => finalize(Object.freeze({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))),
    emit: async (_stdout, value) => { state.emitted += 1; output.stream.write(`${JSON.stringify(value)}\n`); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
  return { app, source, output, runtime, state, derived };
}

test('optimize-compress-local emits a privacy-minimal receipt after verified finalization', async () => {
  const value = fixture();
  await runOptimizeCompressCommand(value.app, { output: 'result.pdf' }, value.source, value.output.stream, undefined, value.runtime);
  const receipt = value.output.value();
  assert.equal(receipt.kind, 'optimize-compress-local');
  assert.equal(receipt.source.sha256, value.source.sha256);
  assert.equal(receipt.outputPdf.sha256, value.derived.sha256);
  assert.equal(receipt.validation.passed, true);
  assert.equal(Object.hasOwn(receipt, 'documentId'), false);
  assert.deepEqual(value.state.deleted, []);
});

test('optimize-compress-local rejects forged provenance without revoking an unvalidated ID', async () => {
  const value = fixture({ forged: true });
  await assert.rejects(runOptimizeCompressCommand(value.app, { output: 'result.pdf' }, value.source, value.output.stream, undefined, value.runtime), { code: 'CLI_INVALID_OPTIMIZE_PROVENANCE' });
  assert.deepEqual(value.state.deleted, []);
});

test('optimize-compress-local revokes the validated document on evidence failure and cancellation after finalization', async () => {
  const invalid = fixture({ evidence: { textPages: [{ page: 1, text: 'forged' }] } });
  await assert.rejects(runOptimizeCompressCommand(invalid.app, { output: 'result.pdf' }, invalid.source, invalid.output.stream, undefined, invalid.runtime), { code: 'CLI_INVALID_OPTIMIZE_EVIDENCE' });
  assert.deepEqual(invalid.state.deleted, [derivedId]);

  const cancelled = fixture({ writer: async (_path, bytes, _signal, finalize) => {
    await finalize(Object.freeze({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
    throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
  } });
  await assert.rejects(runOptimizeCompressCommand(cancelled.app, { output: 'result.pdf' }, cancelled.source, cancelled.output.stream, undefined, cancelled.runtime), { code: 'JOB_CANCELLED' });
  assert.deepEqual(cancelled.state.deleted, []);
});
