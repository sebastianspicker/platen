import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { documentId, fixture, mutation, mutationOptions, sourceDigest } from './support/pdfkit-mutation-service-fixtures.js';

test('PDFKit line authoring binds private geometry to one inert embedded annotation', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const mutationInput = {
    line: {
      page: 1, contents: 'private line review note',
      start: { x: 40, y: 50 }, end: { x: 180, y: 210 },
    },
  };
  const result = await setup.service.mutate(documentId, mutationInput, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-line-annotation-v1',
  });
  assert.equal(result.kind, 'pdfkit-line-annotation-mutation');
  assert.equal(result.artifact.displayName, 'source-line-annotation.pdf');
  assert.equal(result.postflight.category, 'line-annotation');
  assert.equal(result.evidence.lineGeometryVerified, true);
  assert.equal(result.evidence.fixedLineStylesVerified, true);
  const state = setup.state();
  assert.equal(state.observed.request.operation, 'addLineAnnotation');
  assert.deepEqual(state.observed.request.line, mutationInput.line);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, { category: 'line-annotation', page: 1 });
  assert.deepEqual(state.promoted.options.operation.validation.validators.slice(-4), [
    'source-bound-line-annotation', 'line-geometry-reopen', 'fixed-line-styles',
    'native-active-content-graph',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private line|"start"|"end"|"x"|"y"/);
});

test('PDFKit line authoring rejects malformed, active, and signed source requests', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const options = { sourceSha256: sourceDigest, profile: 'macos-pdfkit-line-annotation-v1' };
  const valid = {
    line: { page: 1, contents: 'line', start: { x: 1, y: 1 }, end: { x: 20, y: 20 } },
  };
  for (const input of [
    { ...valid, extra: true },
    { line: { ...valid.line, uri: 'https://example.invalid' } },
    { line: { ...valid.line, page: 3 } },
    { line: { ...valid.line, contents: '' } },
    { line: { ...valid.line, end: { ...valid.line.start } } },
    { line: { ...valid.line, start: { x: Number.NaN, y: 1 } } },
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

test('PDFKit line authoring rejects an unbound or mismatched native receipt before promotion', async (context) => {
  const mutationInput = {
    line: { page: 1, contents: 'line', start: { x: 1, y: 1 }, end: { x: 20, y: 20 } },
  };
  const options = { sourceSha256: sourceDigest, profile: 'macos-pdfkit-line-annotation-v1' };
  for (const lineReceiptOverride of [
    { page: 2 },
    { outputSha256: '0'.repeat(64) },
    { geometryVerified: false },
  ]) {
    const setup = await fixture({ lineReceiptOverride }); context.after(setup.dispose);
    await assert.rejects(setup.service.mutate(documentId, mutationInput, options), {
      code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
    });
    assert.equal(setup.state().promoted, null);
    assert.equal(setup.state().cleaned, true);
  }
});

test('PDFKit ink authoring binds private geometry to one inert embedded annotation', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const mutationInput = {
    ink: {
      page: 1, contents: 'private open-path review note',
      points: [{ x: 40, y: 50 }, { x: 90, y: 120 }, { x: 180, y: 210 }],
    },
  };
  const result = await setup.service.mutate(documentId, mutationInput, {
    sourceSha256: sourceDigest, profile: 'macos-pdfkit-ink-annotation-v1',
  });
  assert.equal(result.kind, 'pdfkit-ink-annotation-mutation');
  assert.equal(result.artifact.displayName, 'source-ink-annotation.pdf');
  assert.equal(result.postflight.category, 'ink-annotation');
  assert.equal(result.evidence.inkGeometryVerified, true);
  assert.equal(result.evidence.rawInkListVerified, true);
  const state = setup.state();
  assert.equal(state.observed.request.operation, 'addInkAnnotation');
  assert.deepEqual(state.observed.request.ink, mutationInput.ink);
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, { category: 'ink-annotation', page: 1 });
  assert.deepEqual(state.promoted.options.operation.validation.validators.slice(-4), [
    'source-bound-ink-annotation', 'ink-geometry-reopen', 'raw-ink-list',
    'native-active-content-graph',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private open-path|"points"|"x"|"y"/);
});

test('PDFKit ink authoring rejects malformed, active, and signed source requests', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const options = { sourceSha256: sourceDigest, profile: 'macos-pdfkit-ink-annotation-v1' };
  const valid = {
    ink: { page: 1, contents: 'ink', points: [{ x: 1, y: 1 }, { x: 20, y: 20 }] },
  };
  for (const input of [
    { ...valid, extra: true },
    { ink: { ...valid.ink, action: 'launch' } },
    { ink: { ...valid.ink, page: 3 } },
    { ink: { ...valid.ink, contents: '' } },
    { ink: { ...valid.ink, points: [{ x: 1, y: 1 }] } },
    { ink: { ...valid.ink, points: Array.from({ length: 33 }, (_, index) => ({ x: index, y: index })) } },
    { ink: { ...valid.ink, points: [{ x: 1, y: 1 }, { x: 1, y: 1 }] } },
    { ink: { ...valid.ink, points: [{ x: Number.NaN, y: 1 }, { x: 2, y: 2 }] } },
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

test('PDFKit ink authoring rejects an unbound or mismatched native receipt before promotion', async (context) => {
  const mutationInput = {
    ink: { page: 1, contents: 'ink', points: [{ x: 1, y: 1 }, { x: 20, y: 20 }] },
  };
  const options = { sourceSha256: sourceDigest, profile: 'macos-pdfkit-ink-annotation-v1' };
  for (const inkReceiptOverride of [
    { page: 2 },
    { outputSha256: '0'.repeat(64) },
    { geometryVerified: false },
    { rawInkListVerified: false },
  ]) {
    const setup = await fixture({ inkReceiptOverride }); context.after(setup.dispose);
    await assert.rejects(setup.service.mutate(documentId, mutationInput, options), {
      code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502,
    });
    assert.equal(setup.state().promoted, null);
    assert.equal(setup.state().cleaned, true);
  }
});
