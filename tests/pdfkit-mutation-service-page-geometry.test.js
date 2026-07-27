import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { documentId, fixture, mutation, mutationOptions, sourceBytes, sourceDigest } from './support/pdfkit-mutation-service-fixtures.js';
test('PDFKit persistent page rotation is source-bound and independently confirmed without rasterization', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const rotation = mutation({
    metadata: null,
    rotation: { page: 2, degrees: 90 },
  });
  const result = await setup.service.mutate(documentId, rotation, mutationOptions());
  const state = setup.state();
  assert.equal(result.kind, 'pdfkit-structure-mutation');
  assert.equal(result.artifact.displayName, 'source-page-2-rotated-90.pdf');
  assert.equal(result.appliedEdits, 1);
  assert.equal(result.postflight.pages[1].rotation, 90);
  assert.equal(result.evidence.persistentPageRotationVerified, true);
  assert.deepEqual(state.observed.request.mutation, rotation);
  assert.deepEqual({ ...state.promoted.options.operation.parameters.rotation }, { page: 2, degrees: 90 });
  assert.deepEqual(state.promoted.options.operation.validation.validators.slice(-3), [
    'source-bound-page-rotation', 'pdfkit-rotation-reopen', 'poppler-page-rotation',
  ]);
  assert.equal(state.promoted.options.operation.validation.rotatedPage, 2);
  assert.equal(state.promoted.options.operation.validation.pageRotation, 90);
  assert.equal(state.promoted.options.operation.expected.rasterized, false);
});

test('PDFKit persistent page rotation rejects malformed, no-op, out-of-document, and signed requests', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const valid = mutation({ metadata: null, rotation: { page: 1, degrees: 90 } });
  for (const input of [
    mutation({ metadata: null, rotation: { page: 1, degrees: 0 } }),
    mutation({ metadata: null, rotation: { page: 1, degrees: 45 } }),
    mutation({ metadata: null, rotation: { page: 1, degrees: 90.5 } }),
    mutation({ metadata: null, rotation: { page: 3, degrees: 90 } }),
    mutation({ metadata: null, rotation: { page: 1, degrees: 90, extra: true } }),
    { ...valid, metadata: { title: 'also edit', author: null, subject: null, keywords: null } },
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, mutationOptions()), {
      code: 'INVALID_PDFKIT_MUTATION', status: 400,
    });
  }
  assert.equal(setup.state().observed, null);

  const signed = await fixture({
    signatureOutput: (input) => [
      `Digital Signature Info of: ${input}`, 'Signature #1:',
      '  - Signed Ranges: [0 - 10], [20 - 30]',
      '  - Total document signed', '  - Signature Validation: Signature is Valid.', '',
    ].join('\n'),
  });
  context.after(signed.dispose);
  await assert.rejects(signed.service.mutate(documentId, valid, mutationOptions()), {
    code: 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED', status: 422,
  });
  assert.equal(signed.state().observed, null);
});

test('PDFKit persistent rotation keeps every source-side native operation on one private copy across a store-path swap', async (context) => {
  const setup = await fixture({ swapSourceDuringNative: true }); context.after(setup.dispose);
  const rotation = mutation({ metadata: null, rotation: { page: 1, degrees: 90 } });
  const result = await setup.service.mutate(documentId, rotation, mutationOptions());
  const state = setup.state();
  assert.equal(result.evidence.persistentPageRotationVerified, true);
  assert.equal(state.sourceSwapped, true);
  assert.deepEqual(state.sourceCalls, ['inspect', 'inspectPage', 'verifySignatures']);
  assert.match(state.stagedSourcePath, /\/job-[^/]+\/input\.pdf$/);
  assert.equal(createHash('sha256').update(await readFile(join(setup.root, 'source.pdf'))).digest('hex'), sourceDigest);
});

test('PDFKit persistent CropBox is source-bound and independently confirmed without rasterization', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const crop = mutation({
    metadata: null,
    pageBox: { page: 2, box: 'crop', rect: { x: 12, y: 18, width: 560, height: 740 } },
  });
  const result = await setup.service.mutate(documentId, crop, mutationOptions());
  const state = setup.state();
  assert.equal(result.kind, 'pdfkit-structure-mutation');
  assert.equal(result.artifact.displayName, 'source-page-2-cropped.pdf');
  assert.equal(result.appliedEdits, 1);
  assert.deepEqual(result.postflight.pages[1].boxes.crop, crop.pageBox.rect);
  assert.equal(result.evidence.persistentCropBoxVerified, true);
  assert.deepEqual(state.observed.request.mutation, crop);
  assert.deepEqual({ ...state.promoted.options.operation.parameters.pageBox }, { page: 2, box: 'crop' });
  assert.deepEqual(state.promoted.options.operation.validation.validators.slice(-3), [
    'source-bound-cropbox', 'pdfkit-cropbox-reopen', 'poppler-cropbox',
  ]);
  assert.equal(state.promoted.options.operation.validation.croppedPage, 2);
  assert.deepEqual({ ...state.promoted.options.operation.validation.persistentCropBox }, crop.pageBox.rect);
  assert.equal(state.promoted.options.operation.expected.rasterized, false);
  assert.match(result.limitations.join(' '), /reveal source content that was previously outside the CropBox/);
});

test('PDFKit persistent CropBox rejects malformed, no-op, out-of-MediaBox, multi-category, and signed requests', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const valid = mutation({
    metadata: null,
    pageBox: { page: 1, box: 'crop', rect: { x: 10, y: 20, width: 580, height: 740 } },
  });
  for (const input of [
    mutation({ metadata: null, pageBox: { page: 1, box: 'crop', rect: { x: 0, y: 0, width: 612, height: 792 } } }),
    mutation({ metadata: null, pageBox: { page: 1, box: 'crop', rect: { x: -1, y: 0, width: 100, height: 100 } } }),
    mutation({ metadata: null, pageBox: { page: 1, box: 'crop', rect: { x: 600, y: 0, width: 20, height: 100 } } }),
    mutation({ metadata: null, pageBox: { page: 3, box: 'crop', rect: { x: 1, y: 1, width: 100, height: 100 } } }),
    mutation({ metadata: null, pageBox: { page: 1, box: 'crop', rect: { x: 1, y: 1, width: 100, height: 100 }, extra: true } }),
    { ...valid, rotation: { page: 1, degrees: 90 } },
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, mutationOptions()), {
      code: 'INVALID_PDFKIT_MUTATION', status: 400,
    });
  }
  assert.equal(setup.state().observed, null);

  const signed = await fixture({
    signatureOutput: (input) => [
      `Digital Signature Info of: ${input}`, 'Signature #1:',
      '  - Signed Ranges: [0 - 10], [20 - 30]',
      '  - Total document signed', '  - Signature Validation: Signature is Valid.', '',
    ].join('\n'),
  });
  context.after(signed.dispose);
  await assert.rejects(signed.service.mutate(documentId, valid, mutationOptions()), {
    code: 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED', status: 422,
  });
  assert.equal(signed.state().observed, null);
});

test('PDFKit persistent CropBox rejects independent Poppler mismatch before promotion', async (context) => {
  const setup = await fixture({ outputCropBoxOverride: { x: 0, y: 0, width: 612, height: 792 } });
  context.after(setup.dispose);
  const crop = mutation({
    metadata: null,
    pageBox: { page: 1, box: 'crop', rect: { x: 10, y: 20, width: 580, height: 740 } },
  });
  await assert.rejects(setup.service.mutate(documentId, crop, mutationOptions()), {
    code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
  });
  assert.equal(setup.state().promoted, null);
});

test('PDFKit persistent CropBox keeps all source-side native operations on one private copy across a store-path swap', async (context) => {
  const setup = await fixture({ swapSourceDuringNative: true }); context.after(setup.dispose);
  const crop = mutation({
    metadata: null,
    pageBox: { page: 1, box: 'crop', rect: { x: 10, y: 20, width: 580, height: 740 } },
  });
  const result = await setup.service.mutate(documentId, crop, mutationOptions());
  const state = setup.state();
  assert.equal(result.evidence.persistentCropBoxVerified, true);
  assert.equal(state.sourceSwapped, true);
  assert.deepEqual(state.sourceCalls, ['inspect', 'inspectPage', 'verifySignatures']);
  assert.match(state.stagedSourcePath, /\/job-[^/]+\/input\.pdf$/);
  assert.equal(createHash('sha256').update(await readFile(join(setup.root, 'source.pdf'))).digest('hex'), sourceDigest);
});

test('PDFKit persistent BleedBox is source-bound and independently confirmed without rasterization', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const bleed = mutation({
    metadata: null,
    pageBox: { page: 2, box: 'bleed', rect: { x: 10, y: 10, width: 592, height: 772 } },
  });
  const result = await setup.service.mutate(documentId, bleed, mutationOptions());
  const state = setup.state();
  assert.equal(result.kind, 'pdfkit-structure-mutation');
  assert.equal(result.artifact.displayName, 'source-page-2-bleed-box.pdf');
  assert.equal(result.appliedEdits, 1);
  assert.deepEqual(result.postflight.pages[1].boxes.bleed, bleed.pageBox.rect);
  assert.equal(result.evidence.persistentBleedBoxVerified, true);
  assert.equal(result.evidence.allPageValidationRendersMatched, true);
  assert.deepEqual(state.observed.request.mutation, bleed);
  assert.deepEqual({ ...state.promoted.options.operation.parameters.pageBox }, {
    page: 2, box: 'bleed',
  });
  assert.deepEqual(state.promoted.options.operation.validation.validators.slice(-4), [
    'source-bound-bleedbox', 'pdfkit-bleedbox-reopen', 'poppler-bleedbox',
    'poppler-render-equality-256px-all-pages',
  ]);
  assert.equal(state.promoted.options.operation.validation.bleedBoxPage, 2);
  assert.deepEqual(
    { ...state.promoted.options.operation.validation.persistentBleedBox },
    bleed.pageBox.rect,
  );
  assert.equal(state.promoted.options.operation.expected.rasterized, false);
  assert.match(result.limitations.join(' '), /explicit-versus-inherited source syntax is not claimed/);
});

test('PDFKit persistent BleedBox rejects no-op, unsafe containment, multi-category, and signed requests', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const valid = mutation({
    metadata: null,
    pageBox: { page: 1, box: 'bleed', rect: { x: 10, y: 10, width: 592, height: 772 } },
  });
  for (const input of [
    mutation({ metadata: null, pageBox: { page: 1, box: 'bleed', rect: { x: 0, y: 0, width: 612, height: 792 } } }),
    mutation({ metadata: null, pageBox: { page: 1, box: 'bleed', rect: { x: -1, y: 0, width: 612, height: 792 } } }),
    mutation({ metadata: null, pageBox: { page: 1, box: 'bleed', rect: { x: 30, y: 30, width: 552, height: 732 } } }),
    { ...valid, rotation: { page: 1, degrees: 90 } },
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, mutationOptions()), {
      code: 'INVALID_PDFKIT_MUTATION', status: 400,
    });
  }
  assert.equal(setup.state().observed, null);

  const signed = await fixture({
    signatureOutput: (input) => [
      `Digital Signature Info of: ${input}`, 'Signature #1:',
      '  - Signed Ranges: [0 - 10], [20 - 30]',
      '  - Total document signed', '  - Signature Validation: Signature is Valid.', '',
    ].join('\n'),
  });
  context.after(signed.dispose);
  await assert.rejects(signed.service.mutate(documentId, valid, mutationOptions()), {
    code: 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED', status: 422,
  });
  assert.equal(signed.state().observed, null);
});

test('PDFKit persistent BleedBox rejects independent Poppler mismatch before promotion', async (context) => {
  const setup = await fixture({
    outputBleedBoxOverride: { x: 0, y: 0, width: 612, height: 792 },
  });
  context.after(setup.dispose);
  const bleed = mutation({
    metadata: null,
    pageBox: { page: 1, box: 'bleed', rect: { x: 10, y: 10, width: 592, height: 772 } },
  });
  await assert.rejects(setup.service.mutate(documentId, bleed, mutationOptions()), {
    code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
  });
  assert.equal(setup.state().promoted, null);
});

test('PDFKit persistent BleedBox rejects any ordinary page-render change before promotion', async (context) => {
  const setup = await fixture({
    outputRenderBytes: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('changed')]),
  });
  context.after(setup.dispose);
  const bleed = mutation({
    metadata: null,
    pageBox: { page: 1, box: 'bleed', rect: { x: 10, y: 10, width: 592, height: 772 } },
  });
  await assert.rejects(setup.service.mutate(documentId, bleed, mutationOptions()), {
    code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
  });
  assert.equal(setup.state().promoted, null);
});

test('PDFKit persistent BleedBox keeps inspection and render comparison on one private source copy', async (context) => {
  const setup = await fixture({ swapSourceDuringNative: true }); context.after(setup.dispose);
  const bleed = mutation({
    metadata: null,
    pageBox: { page: 1, box: 'bleed', rect: { x: 10, y: 10, width: 592, height: 772 } },
  });
  const result = await setup.service.mutate(documentId, bleed, mutationOptions());
  const state = setup.state();
  assert.equal(result.evidence.persistentBleedBoxVerified, true);
  assert.equal(result.evidence.allPageValidationRendersMatched, true);
  assert.equal(state.sourceSwapped, true);
  assert.deepEqual(state.sourceCalls.slice(0, 3), ['inspect', 'inspectPage', 'verifySignatures']);
  assert.equal(state.sourceCalls.filter((operation) => operation === 'renderPagePng').length, 2);
  assert.match(state.stagedSourcePath, /\/job-[^/]+\/input\.pdf$/);
  assert.equal(
    createHash('sha256').update(await readFile(join(setup.root, 'source.pdf'))).digest('hex'),
    sourceDigest,
  );
});
