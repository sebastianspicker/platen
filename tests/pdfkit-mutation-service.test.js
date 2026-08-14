import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { documentId, fixture, mutation, mutationOptions, nativeOutput, sourceDigest } from './support/pdfkit-mutation-service-fixtures.js';
test('PDFKit mutation creates and independently validates a separate non-raster artifact', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const result = await setup.service.mutate(documentId, mutation(), mutationOptions());
  assert.equal(result.kind, 'pdfkit-structure-mutation');
  assert.equal(result.sourceDigest, sourceDigest);
  assert.equal(result.appliedEdits, 4);
  assert.equal(result.evidence.rasterized, false);
  assert.equal(result.evidence.allPagesRendered, true);
  assert.equal(result.artifact.displayName, 'source-pdfkit-edited.pdf');
  assert.equal(Object.isFrozen(result.postflight.pages), true);
  const state = setup.state();
  assert.equal(state.verified, 2);
  assert.equal(state.cleaned, true);
  assert.equal(state.observed.inputMode, 0o400);
  assert.equal(state.observed.requestMode, 0o400);
  assert.equal(state.observed.request.operation, 'mutate');
  assert.deepEqual(state.observed.request.mutation, mutation());
  assert.equal(state.observed.options.timeoutMs, 30_000);
  assert.equal(state.promoted.output.equals(nativeOutput), true);
  assert.equal(state.promoted.options.operation.validation.renderedPages, 2);
  assert.equal(state.promoted.options.expectedSha256, result.artifact.sha256);
  assert.equal(state.promoted.options.signal instanceof AbortSignal, true);
  const provenance = JSON.stringify(state.promoted.options.operation);
  assert.doesNotMatch(provenance, /Edited|fieldName|contents/);
});

test('PDFKit derived mutation accepts one embedded sticky note without retaining contents', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const stickyNote = mutation({
    metadata: null,
    annotations: [{ page: 1, subtype: 'text', contents: 'Private sticky note', rect: { x: 10, y: 10, width: 40, height: 40 } }],
  });
  const result = await setup.service.mutate(documentId, stickyNote, mutationOptions());
  const state = setup.state();
  assert.equal(result.appliedEdits, 1);
  assert.deepEqual(state.observed.request.mutation, stickyNote);
  assert.deepEqual(
    JSON.parse(JSON.stringify(state.promoted.options.operation.parameters.annotations)),
    [{ page: 1, subtype: 'text' }],
  );
  assert.doesNotMatch(JSON.stringify(result), /Private sticky note/);
  assert.doesNotMatch(JSON.stringify(state.promoted.options.operation), /Private sticky note|contents/);
});

test('PDFKit mutation rejects receipt source and output digest mismatches before validation or promotion', async (context) => {
  for (const mutationReceiptOverride of [
    { sourceSha256: '0'.repeat(64) },
    { outputSha256: '0'.repeat(64) },
  ]) {
    const setup = await fixture({ mutationReceiptOverride }); context.after(setup.dispose);
    await assert.rejects(setup.service.mutate(documentId, mutation(), mutationOptions()), {
      code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
    });
    const state = setup.state();
    assert.equal(state.promoted, null);
    assert.equal(state.cleaned, true);
  }
});
