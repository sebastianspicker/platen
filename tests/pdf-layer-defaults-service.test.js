import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfLayerDefaultsService } from '../scripts/host/pdf-layer-defaults-service.mjs';
import { PDF_LAYER_DEFAULTS_PROFILE } from '../scripts/host/pdf-layer-defaults-contract.mjs';
import { inspectPdfLayerDefaults, writePdfLayerDefaults } from '../scripts/host/pdf-layer-defaults-writer.mjs';

function fixture({ dExtra = '', catalogExtra = '' } = {}) {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const object = (number, body, stream = null) => {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\n`);
    if (stream !== null) chunks.push(`stream\n${stream}endstream\n`);
    chunks.push('endobj\n');
  };
  object(1, `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R 8 0 R] /D << /BaseState /ON${dExtra} >> >>${catalogExtra} >>`);
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

async function setup(context, source = fixture()) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-layer-defaults-service-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const document = await store.createDocument({
    stream: Readable.from([source]), displayName: 'source.pdf', mediaType: 'application/pdf',
  });
  const request = { profile: PDF_LAYER_DEFAULTS_PROFILE, changes: [{ groupIndex: 1, visible: false }] };
  return { root, store, document, request, sourceSha256: document.sha256 };
}

test('layer-defaults service promotes a source-bound artifact and cleans its job workspace', async (context) => {
  const setupValue = await setup(context);
  const service = new PdfLayerDefaultsService({ store: setupValue.store });
  const result = await service.update(setupValue.document.id, setupValue.request, {
    sourceSha256: setupValue.sourceSha256,
  });
  assert.equal(result.kind, 'pdf-layer-defaults');
  assert.equal(result.proof.profile, PDF_LAYER_DEFAULTS_PROFILE);
  assert.deepEqual(result.proof.visible, [true, false]);
  assert.equal(result.evidence.onlyCatalogChanged, true);
  assert.notEqual(result.artifact.sha256, setupValue.sourceSha256);
  assert.deepEqual({ ...result.artifact.operation.parameters }, {
    groupCount: 2, visibleGroupIndices: [0], hiddenGroupIndices: [1],
  });
  assert.equal(Object.hasOwn(result.artifact.operation.parameters, 'name'), false);
  assert.equal(await setupValue.store.verifySource(setupValue.document.id), true);
  assert.deepEqual(await readdir(join(setupValue.root, 'jobs')), []);
  assert.ok((await readFile(setupValue.store.getArtifact(result.artifact.id).filePath)).subarray(0, 5).equals(Buffer.from('%PDF-')));
});

test('layer-defaults service rejects stale sources, cancellation, tampered proofs, and unsupported PDFs', async (context) => {
  const stale = await setup(context);
  const staleService = new PdfLayerDefaultsService({ store: stale.store });
  await assert.rejects(staleService.update(stale.document.id, stale.request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });

  const cancelled = await setup(context);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  const cancelledService = new PdfLayerDefaultsService({ store: cancelled.store });
  await assert.rejects(cancelledService.update(cancelled.document.id, cancelled.request, { sourceSha256: cancelled.sourceSha256, signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.deepEqual(await readdir(join(cancelled.root, 'jobs')), []);

  const tampered = await setup(context);
  const tamperedService = new PdfLayerDefaultsService({
    store: tampered.store,
    core: {
      normalizePdfLayerDefaults: (value) => ({ ...value, changes: value.changes.map((change) => ({ ...change })) }),
      writePdfLayerDefaults: (bytes, request) => {
        const written = writePdfLayerDefaults(bytes, request);
        return { bytes: Buffer.concat([written.bytes, Buffer.from('tamper')]), proof: written.proof };
      },
      inspectPdfLayerDefaults,
    },
  });
  await assert.rejects(tamperedService.update(tampered.document.id, tampered.request, { sourceSha256: tampered.sourceSha256 }), { code: 'PDF_LAYER_DEFAULTS_OUTPUT_INVALID', status: 502 });
  assert.deepEqual(await readdir(join(tampered.root, 'jobs')), []);

  for (const source of [
    fixture({ dExtra: ' /OFF [7 0 R 7 0 R]' }),
    fixture({ catalogExtra: ' /Encrypt 7 0 R' }),
    fixture({ catalogExtra: ' /ByteRange [0 1 2 3]' }),
  ]) {
    const unsupported = await setup(context, source);
    const service = new PdfLayerDefaultsService({ store: unsupported.store });
    await assert.rejects(service.update(unsupported.document.id, unsupported.request, { sourceSha256: unsupported.sourceSha256 }), { code: 'PDF_LAYER_DEFAULTS_SOURCE_UNSUPPORTED', status: 422 });
    assert.deepEqual(await readdir(join(unsupported.root, 'jobs')), []);
  }
});

test('layer-defaults service detects source mutation before promotion', async (context) => {
  const value = await setup(context);
  const path = value.store.getSourcePath(value.document.id);
  await writeFile(path, Buffer.concat([fixture(), Buffer.from('mutated')]), { mode: 0o600 });
  const service = new PdfLayerDefaultsService({ store: value.store });
  await assert.rejects(service.update(value.document.id, value.request, { sourceSha256: value.sourceSha256 }), { code: 'SOURCE_INTEGRITY_FAILED', status: 500 });
});

test('layer-defaults service independently rejects a writer proof mutation', async (context) => {
  const value = await setup(context);
  const service = new PdfLayerDefaultsService({
    store: value.store,
    core: {
      normalizePdfLayerDefaults: (request) => request,
      writePdfLayerDefaults: (source, request) => writePdfLayerDefaults(source, request),
      inspectPdfLayerDefaults: (source, output, request) => ({
        ...inspectPdfLayerDefaults(source, output, request), groupCount: 1,
      }),
    },
  });
  await assert.rejects(service.update(value.document.id, value.request, { sourceSha256: value.sourceSha256 }), { code: 'PDF_LAYER_DEFAULTS_OUTPUT_INVALID', status: 502 });
});
