import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { documentId, fixture, mutation, mutationOptions, sourceBytes, sourceDigest } from './support/pdfkit-mutation-service-fixtures.js';
test('PDFKit local GoTo authoring binds one internal destination and promotes only the compact proof', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const localGoTo = {
    link: { sourcePage: 1, targetPage: 2, rect: { x: 20, y: 320, width: 120, height: 30 } },
  };
  const result = await setup.service.mutate(documentId, localGoTo, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-local-goto-v1',
  });
  assert.equal(result.kind, 'pdfkit-local-goto-mutation');
  assert.equal(result.artifact.displayName, 'source-local-link.pdf');
  assert.equal(result.postflight.category, 'local-goto-link');
  assert.equal(result.evidence.rawDestinationVerified, true);
  const state = setup.state();
  assert.equal(state.observed.request.operation, 'addLocalGoToLink');
  assert.equal(state.observed.request.sourceSha256, sourceDigest);
  assert.deepEqual(state.observed.request.link, localGoTo.link);
  assert.equal(Object.hasOwn(state.observed.request, 'mutation'), false);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'local-goto-link', sourcePage: 1, targetPage: 2,
  });
  assert.deepEqual(state.promoted.options.operation.validation.validators.slice(-4), [
    'source-bound-local-goto', 'raw-destination-delta', 'local-goto-action-shape',
    'native-active-content-graph',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /\"rect\"|https?:/);
});

test('PDFKit local GoTo rejects malformed, out-of-document, active, and signed source requests', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const options = { sourceSha256: sourceDigest, profile: 'macos-pdfkit-local-goto-v1' };
  const valid = { link: { sourcePage: 1, targetPage: 2, rect: { x: 1, y: 1, width: 20, height: 10 } } };
  for (const input of [
    { ...valid, extra: true },
    { link: { ...valid.link, uri: 'https://example.invalid' } },
    { link: { ...valid.link, sourcePage: 0 } },
    { link: { ...valid.link, targetPage: 3 } },
    { link: { ...valid.link, rect: { ...valid.link.rect, width: 0 } } },
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, options), {
      code: 'INVALID_PDFKIT_MUTATION', status: 400,
    });
  }
  assert.equal(setup.state().observed, null);

  const active = await fixture({ sourceSafety: 'Encrypted: no\nForm: none\nJavaScript: yes' });
  context.after(active.dispose);
  await assert.rejects(active.service.mutate(documentId, valid, options), {
    code: 'PDFKIT_SOURCE_UNSUPPORTED', status: 422,
  });

  const signed = await fixture({
    signatureOutput: (input) => [
      `Digital Signature Info of: ${input}`, 'Signature #1:',
      '  - Signed Ranges: [0 - 10], [20 - 30]',
      '  - Total document signed', '  - Signature Validation: Signature is Valid.', '',
    ].join('\n'),
  });
  context.after(signed.dispose);
  await assert.rejects(signed.service.mutate(documentId, valid, options), {
    code: 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED', status: 422,
  });
});

test('PDFKit local GoTo rejects an unbound or mismatched native receipt before promotion', async (context) => {
  const mutationInput = {
    link: { sourcePage: 1, targetPage: 2, rect: { x: 1, y: 1, width: 20, height: 10 } },
  };
  const options = { sourceSha256: sourceDigest, profile: 'macos-pdfkit-local-goto-v1' };
  for (const localReceiptOverride of [
    { targetPage: 1 },
    { outputSha256: '0'.repeat(64) },
    { rawDestinationVerified: false },
  ]) {
    const setup = await fixture({ localReceiptOverride }); context.after(setup.dispose);
    await assert.rejects(setup.service.mutate(documentId, mutationInput, options), {
      code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
    });
    assert.equal(setup.state().promoted, null);
    assert.equal(setup.state().cleaned, true);
  }
});

test('PDFKit local GoTo removal promotes only one exact source-bound annotation delta', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const fingerprint = 'f'.repeat(64);
  const linkRemoval = { linkRemoval: { page: 1, annotationIndex: 0, fingerprint } };
  const result = await setup.service.mutate(documentId, linkRemoval, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-local-goto-remove-v1',
  });
  assert.equal(result.kind, 'pdfkit-local-goto-removal');
  assert.equal(result.artifact.displayName, 'source-local-link-removed.pdf');
  assert.equal(result.postflight.category, 'local-goto-link-removal');
  assert.equal(result.evidence.rawLocalGoToTargetVerified, true);
  assert.equal(result.evidence.annotationInventoryVerified, true);
  const state = setup.state();
  assert.equal(state.observed.request.operation, 'removeLocalGoToLink');
  assert.equal(state.observed.request.sourceSha256, sourceDigest);
  assert.deepEqual(state.observed.request.link, linkRemoval.linkRemoval);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    category: 'local-goto-link-removal', page: 1, annotationIndex: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fingerprint, 'u'));
});

test('PDFKit local GoTo removal rejects malformed locators and mismatched native proof', async (context) => {
  const fingerprint = 'f'.repeat(64);
  const valid = { linkRemoval: { page: 1, annotationIndex: 0, fingerprint } };
  const options = {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-local-goto-remove-v1',
  };
  const setup = await fixture(); context.after(setup.dispose);
  for (const input of [
    { ...valid, targetPage: 2 },
    { linkRemoval: { ...valid.linkRemoval, page: 3 } },
    { linkRemoval: { ...valid.linkRemoval, annotationIndex: 50 } },
    { linkRemoval: { ...valid.linkRemoval, fingerprint: 'F'.repeat(64) } },
  ]) {
    await assert.rejects(setup.service.mutate(documentId, input, options), {
      code: 'INVALID_PDFKIT_MUTATION', status: 400,
    });
  }
  assert.equal(setup.state().observed, null);

  for (const localRemovalReceiptOverride of [
    { page: 2 },
    { annotationIndex: 1 },
    { outputSha256: '0'.repeat(64) },
    { rawTargetVerified: false },
    { annotationRemoved: false },
    { pageGeometryVerified: false },
    { annotationInventoryVerified: false },
  ]) {
    const mismatched = await fixture({ localRemovalReceiptOverride });
    context.after(mismatched.dispose);
    await assert.rejects(mismatched.service.mutate(documentId, valid, options), {
      code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
    });
    assert.equal(mismatched.state().promoted, null);
  }
});
