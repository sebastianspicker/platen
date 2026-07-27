import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { PdfKitMutationService } from '../scripts/host/pdfkit-mutation-service.mjs';
import { documentId, fixture, inspection, mutation, mutationOptions, png, sourceBytes, sourceDigest } from './support/pdfkit-mutation-service-fixtures.js';

test('PDFKit mutation rejects no-op, extra, oversized, and out-of-document requests before native execution', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  for (const input of [
    { metadata: null, pageBox: null, annotations: [] },
    mutation({ metadata: { title: null, author: null, subject: null, keywords: null } }),
    { ...mutation(), unexpected: true },
    mutation({ metadata: null, pageBox: { page: 3, box: 'crop', rect: { x: 0, y: 0, width: 100, height: 100 } } }),
    mutation({ metadata: { title: 'x'.repeat(1_025), author: null, subject: null, keywords: null } }),
    mutation({ annotations: [{ page: 1, subtype: 'stamp', contents: 'unsafe', rect: { x: 10, y: 10, width: 40, height: 40 } }] }),
    mutation({ pageBox: { page: 1, box: 'crop', rect: { x: 0, y: 0, width: 100, height: 100 } } }),
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, mutationOptions()), { code: 'INVALID_PDFKIT_MUTATION', status: 400 });
  }
  await assert.rejects(setup.service.mutate(documentId, mutation(), { sourceSha256: '0'.repeat(64) }), {
    code: 'SOURCE_VERSION_MISMATCH', status: 409,
  });
  assert.equal(setup.state().observed, null);
});

test('PDFKit mutation fails closed for encrypted, form-bearing, JavaScript, or unknown source evidence', async (context) => {
  for (const sourceSafety of [
    'Encrypted: yes\nForm: none\nJavaScript: no',
    'Encrypted: no\nForm: AcroForm\nJavaScript: no',
    'Encrypted: no\nForm: none\nJavaScript: yes',
    '',
  ]) {
    const setup = await fixture({ sourceSafety }); context.after(setup.dispose);
    await assert.rejects(setup.service.mutate(documentId, mutation(), mutationOptions()), {
      code: 'PDFKIT_SOURCE_UNSUPPORTED', status: 422,
    });
    assert.equal(setup.state().observed, null);
  }
});

test('PDFKit mutation rejects helper workspace changes and native or Poppler page-count disagreement', async (context) => {
  const unsafe = await fixture({ unsafeOutput: true }); context.after(unsafe.dispose);
  await assert.rejects(unsafe.service.mutate(documentId, mutation(), mutationOptions()), { code: 'PDFKIT_WORKSPACE_INVALID' });
  assert.equal(unsafe.state().cleaned, true);

  const nativeMismatch = await fixture({ helperPages: 3 }); context.after(nativeMismatch.dispose);
  await assert.rejects(nativeMismatch.service.mutate(documentId, mutation(), mutationOptions()), { code: 'PDFKIT_POSTFLIGHT_INVALID' });

  const popplerMismatch = await fixture({ outputPages: 3 }); context.after(popplerMismatch.dispose);
  await assert.rejects(popplerMismatch.service.mutate(documentId, mutation(), mutationOptions()), { code: 'PDFKIT_PAGE_COUNT_MISMATCH' });
});

test('PDFKit mutation requires every output page to render and maps cancellation safely', async (context) => {
  const badRaster = await fixture({ invalidPng: true }); context.after(badRaster.dispose);
  await assert.rejects(badRaster.service.mutate(documentId, mutation(), mutationOptions()), { code: 'PDFKIT_OUTPUT_INVALID' });

  const cancelled = await fixture(); context.after(cancelled.dispose);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.service.mutate(documentId, mutation(), mutationOptions(controller.signal)), {
    code: 'JOB_CANCELLED', status: 499,
  });

  const changedWorkspace = await fixture({ unsafeValidationOutput: true }); context.after(changedWorkspace.dispose);
  await assert.rejects(changedWorkspace.service.mutate(documentId, mutation(), mutationOptions()), {
    code: 'PDFKIT_WORKSPACE_INVALID', status: 502,
  });
});

test('PDFKit mutation rejects unsafe output topology', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  setup.service = new PdfKitMutationService({
    store: {
      getDocument: () => ({ id: documentId, sha256: sourceDigest, size: sourceBytes.length, displayName: 'source.pdf' }),
      getSourcePath: () => join(setup.root, 'source.pdf'), verifySource: async () => {},
      createJobWorkspace: async () => mkdtemp(join(setup.root, 'job-')),
      cleanupJob: async (workspace) => rm(workspace, { recursive: true, force: true }),
      promotePdfArtifact: async () => assert.fail('unsafe output must not be promoted'),
    },
    poppler: { async execute(operation, parameters) {
      if (operation === 'inspect') return { stdout: 'Pages: 2\nEncrypted: no\nForm: none\nJavaScript: no\n' };
      if (operation === 'renderPagePng') await writeFile(`${parameters.outputPrefix}.png`, png, { mode: 0o600 });
      return { stdout: '' };
    } },
    adapter: { async mutate({ workspacePath }) {
      await writeFile(join(workspacePath, 'output.pdf'), Buffer.alloc(0), { mode: 0o600 });
      return { appliedEdits: 4, inspection: inspection() };
    } },
  });
  await assert.rejects(setup.service.mutate(documentId, mutation(), mutationOptions()), { code: 'PDFKIT_OUTPUT_INVALID' });
});

test('targeted PDFKit mutation binds a private form value to an exact source locator without retaining it', async (context) => {
  const setup = await fixture({ sourceSafety: 'Encrypted: no\nForm: AcroForm\nJavaScript: no' });
  context.after(setup.dispose);
  const targeted = {
    formFill: {
      page: 1, annotationIndex: 0, fingerprint: 'd'.repeat(64), fieldType: 'text', value: 'private form value',
    },
    annotationUpdate: null,
    annotationRemove: null,
  };
  const result = await setup.service.mutate(documentId, targeted, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-targeted-v1',
  });
  assert.equal(result.kind, 'pdfkit-targeted-mutation');
  const state = setup.state();
  assert.equal(state.observed.request.operation, 'targetedMutate');
  assert.equal(state.observed.request.sourceSha256, sourceDigest);
  assert.deepEqual(state.observed.request.mutation, targeted);
  assert.equal(state.promoted.options.operation.type, 'pdfkit-targeted-mutation');
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'form-fill', page: 1, annotationIndex: 0, fieldType: 'text',
  });
  assert.doesNotMatch(JSON.stringify(result), /private form value/);
  assert.doesNotMatch(JSON.stringify(state.promoted.options.operation), /private form value|dddddddddddddddd/);
});

test('targeted PDFKit mutation forwards only an on/off checkbox intent without retaining state details', async (context) => {
  const setup = await fixture({ sourceSafety: 'Encrypted: no\nForm: AcroForm\nJavaScript: no' });
  context.after(setup.dispose);
  const targeted = {
    formFill: {
      page: 1, annotationIndex: 0, fingerprint: 'e'.repeat(64), fieldType: 'button', value: 'on',
    },
    annotationUpdate: null,
    annotationRemove: null,
  };
  const result = await setup.service.mutate(documentId, targeted, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-targeted-v1',
  });
  assert.equal(result.kind, 'pdfkit-targeted-mutation');
  const state = setup.state();
  assert.deepEqual(state.observed.request.mutation, targeted);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'form-fill', page: 1, annotationIndex: 0, fieldType: 'button',
  });
  assert.equal(Object.hasOwn(state.promoted.options.operation.parameters, 'value'), false);
  assert.equal(Object.hasOwn(state.promoted.options.operation.parameters, 'fingerprint'), false);
});

test('targeted PDFKit mutation records only a fixed canonical radio-selection intent', async (context) => {
  const setup = await fixture({ sourceSafety: 'Encrypted: no\nForm: AcroForm\nJavaScript: no' });
  context.after(setup.dispose);
  const targeted = {
    formFill: {
      page: 2, annotationIndex: 4, fingerprint: '9'.repeat(64), fieldType: 'button', value: 'select',
    },
    annotationUpdate: null,
    annotationRemove: null,
  };
  const result = await setup.service.mutate(documentId, targeted, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-targeted-v1',
  });
  const state = setup.state();
  assert.deepEqual(state.observed.request.mutation, targeted);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'form-radio-select', page: 2, annotationIndex: 4, fieldType: 'button',
  });
  assert.equal(result.evidence.canonicalRadioGroupSelectionVerified, true);
  assert.equal(state.promoted.options.operation.validation.validators.includes('source-bound-radio-group'), true);
  assert.equal(state.promoted.options.operation.validation.validators.includes('raw-radio-v-as-state'), true);
  assert.equal(state.promoted.options.operation.validation.validators.includes('radio-render-change'), true);
  assert.equal(Object.hasOwn(state.promoted.options.operation.parameters, 'value'), false);
  assert.equal(Object.hasOwn(state.promoted.options.operation.parameters, 'fingerprint'), false);
  assert.doesNotMatch(JSON.stringify(result), /9999999999999999|private-radio-state/);
});

test('targeted annotation removal records a verified selective-sanitization delta without private locator data', async (context) => {
  const setup = await fixture();
  context.after(setup.dispose);
  const targeted = {
    formFill: null,
    annotationUpdate: null,
    annotationRemove: {
      page: 1, annotationIndex: 3, fingerprint: '7'.repeat(64), subtype: 'freeText',
    },
  };
  const result = await setup.service.mutate(documentId, targeted, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-targeted-v1',
  });
  const state = setup.state();
  assert.equal(result.kind, 'pdfkit-selective-sanitization');
  assert.equal(result.artifact.displayName, 'source-annotation-removed.pdf');
  assert.equal(result.evidence.reachableAnnotationRemovalVerified, true);
  assert.equal(state.promoted.options.operation.type, 'pdfkit-selective-sanitization');
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'annotation-remove', page: 1, annotationIndex: 3, subtype: 'freeText',
  });
  assert.equal(
    state.promoted.options.operation.validation.validators.includes('raw-reachable-annotation-delta'),
    true,
  );
  assert.match(result.limitations.join(' '), /orphan-byte scrubbing/);
  assert.doesNotMatch(JSON.stringify(result), /7777777777777777/);
  assert.doesNotMatch(JSON.stringify(state.promoted.options.operation), /7777777777777777|fingerprint|contents/);
});

test('targeted PDFKit mutation identifies an empty choice as a private clear operation', async (context) => {
  const setup = await fixture({ sourceSafety: 'Encrypted: no\nForm: AcroForm\nJavaScript: no' });
  context.after(setup.dispose);
  const targeted = {
    formFill: {
      page: 1, annotationIndex: 1, fingerprint: 'f'.repeat(64), fieldType: 'choice', value: '',
    },
    annotationUpdate: null,
    annotationRemove: null,
  };
  await setup.service.mutate(documentId, targeted, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-targeted-v1',
  });
  const state = setup.state();
  assert.deepEqual(state.observed.request.mutation, targeted);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'form-choice-clear', page: 1, annotationIndex: 1, fieldType: 'choice',
  });
  assert.equal(Object.hasOwn(state.promoted.options.operation.parameters, 'value'), false);
  assert.equal(Object.hasOwn(state.promoted.options.operation.parameters, 'fingerprint'), false);
});

test('targeted PDFKit mutation rejects unsafe source classes, signed input, and malformed locator categories', async (context) => {
  const signed = await fixture({
    sourceSafety: 'Encrypted: no\nForm: AcroForm\nJavaScript: no',
    signatureOutput: (input) => [
      `Digital Signature Info of: ${input}`,
      'Signature #1:',
      '  - Signing Hash Algorithm: SHA-256',
      '  - Signature Type: adbe.pkcs7.detached',
      '  - Signed Ranges: [0 - 500], [4096 - 8191]',
      '  - Total document signed',
      '  - Signature Validation: Signature is Valid.',
      '',
    ].join('\n'),
  });
  context.after(signed.dispose);
  const formFill = {
    formFill: { page: 1, annotationIndex: 0, fingerprint: 'd'.repeat(64), fieldType: 'text', value: '' },
    annotationUpdate: null, annotationRemove: null,
  };
  await assert.rejects(signed.service.mutate(documentId, formFill, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-targeted-v1',
  }), { code: 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED', status: 422 });

  const plain = await fixture(); context.after(plain.dispose);
  await assert.rejects(plain.service.mutate(documentId, formFill, {
    sourceSha256: sourceDigest, profile: 'unsupported-profile',
  }), { code: 'INVALID_PDFKIT_MUTATION', status: 400 });
  for (const targeted of [
    { formFill: null, annotationUpdate: null, annotationRemove: null },
    { ...formFill, unexpected: true },
    { ...formFill, formFill: { ...formFill.formFill, fingerprint: 'D'.repeat(64) } },
    { ...formFill, formFill: { ...formFill.formFill, fieldType: 'button', value: 'checked' } },
    { formFill: null, annotationUpdate: { page: 1, annotationIndex: 0, fingerprint: 'd'.repeat(64), subtype: 'text', contents: 'x', rect: { x: 1, y: 1, width: 10, height: 10 } }, annotationRemove: null },
  ]) {
    await assert.rejects(plain.service.mutate(documentId, targeted, {
      sourceSha256: sourceDigest, profile: 'macos-pdfkit-targeted-v1',
    }), { code: 'INVALID_PDFKIT_MUTATION', status: 400 });
  }
  await assert.rejects(plain.service.mutate(documentId, formFill, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-targeted-v1',
  }), { code: 'PDFKIT_SOURCE_UNSUPPORTED', status: 422 });
});
