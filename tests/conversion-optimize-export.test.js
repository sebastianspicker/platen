import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { GhostscriptAdapter } from '../scripts/host/adapters/ghostscript.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import {
  OPTIMIZE_VALIDATORS,
  prepareOptimizePdfExport,
} from '../scripts/host/conversion-optimize-export.mjs';

async function harness(context, { outputText = 'Alpha', validators = OPTIMIZE_VALIDATORS } = {}) {
  const root = await mkdtemp(`${tmpdir()}/platen-optimize-export-`);
  const documents = await new DocumentStore({ root }).initialize();
  context.after(async () => { await documents.dispose(); await rm(root, { recursive: true, force: true }); });
  const source = await documents.createDocument({
    stream: Readable.from([createTextPdf({ text: 'Alpha', title: 'Source' })]), displayName: 'source.pdf',
  });
  const output = createTextPdf({ text: outputText, title: 'Optimized' });
  const operation = createOperationProvenance({
    type: 'optimize-pdf',
    inputs: [{ documentId: source.id, sha256: source.sha256, role: 'primary' }],
    parameters: { mode: 'optimize' }, expected: { pageCount: 1 },
    validation: { passed: true, validators: [...validators], pageCount: 1 },
  });
  const derived = await documents.createDocument({
    stream: Readable.from([output]), displayName: 'source-optimized.pdf', operation,
  });
  const registry = new EngineRegistry();
  return { documents, source, derived, poppler: new PopplerAdapter({ registry }), ghostscript: new GhostscriptAdapter({ registry }) };
}

test('optimize export rejects forged provenance before retaining or revoking anything', async (context) => {
  const value = await harness(context, { validators: ['source-sha256', 'fallback', 'pdfinfo-page-count'] });
  await assert.rejects(
    prepareOptimizePdfExport({ documents: value.documents, poppler: value.poppler, documentId: value.derived.id }),
    { code: 'INVALID_OPTIMIZE_PROVENANCE', status: 403 },
  );
  assert.equal(value.documents.getDocument(value.derived.id).id, value.derived.id);
});

test('optimize export rejects semantic mismatch and revokes the validated derived document', async (context) => {
  const value = await harness(context, { outputText: 'Different text' });
  await assert.rejects(
    prepareOptimizePdfExport({ documents: value.documents, poppler: value.poppler, documentId: value.derived.id }),
    { code: 'OPTIMIZE_SEMANTIC_MISMATCH', status: 502 },
  );
  assert.throws(() => value.documents.getDocument(value.derived.id), { code: 'DOCUMENT_NOT_FOUND' });
});

test('optimize export cancellation revokes only the validated derived document', async (context) => {
  const value = await harness(context);
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED', status: 499 }));
  await assert.rejects(
    prepareOptimizePdfExport({ documents: value.documents, poppler: value.poppler, documentId: value.derived.id, externalSignal: controller.signal }),
    { code: 'JOB_CANCELLED' },
  );
  assert.throws(() => value.documents.getDocument(value.derived.id), { code: 'DOCUMENT_NOT_FOUND' });
  assert.equal(value.documents.getDocument(value.source.id).id, value.source.id);
});

test('installed Ghostscript and Poppler prove the retained optimize rewrite end to end', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/gs', '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext'].map((path) => access(path)));
  } catch {
    context.skip('The fixed Ghostscript and Poppler tools are unavailable.');
    return;
  }
  const value = await harness(context);
  const rewritten = await (await import('../scripts/host/conversion-rewrite.mjs')).rewritePdfDocument({
    documents: value.documents, poppler: value.poppler, ghostscript: value.ghostscript, documentId: value.source.id, mode: 'optimize',
  });
  const evidence = await prepareOptimizePdfExport({ documents: value.documents, poppler: value.poppler, documentId: rewritten.id });
  assert.equal(evidence.pageCount, 1);
  assert.equal(evidence.textPages[0].text, 'Alpha');
  assert.deepEqual(evidence.passiveIndicators, { encrypted: 'no', javascript: 'no', form: 'none' });
  assert.equal(evidence.outputDigest, rewritten.sha256);
});
