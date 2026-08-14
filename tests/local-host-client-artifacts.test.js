import test from 'node:test';
import {
  aecCalibrationResult,
  aecMeasurementResult,
  aecSourceBinding,
  assert,
  LocalHostClient,
  metadataSanitizationResult,
  ocrDocumentResult,
  ocrLayoutResult,
  protectionRemovalResult,
  token,
} from './support/local-host-client-fixture.js';

test('local host client exposes only fixed-profile PDFKit password protection', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: { kind: 'pdfkit-password-protection', artifact: { id: 'protected' } } }), { status: 201 });
  } });
  await client.bootstrap();
  const protection = {
    permissionsProfile: 'accessibility-only',
    ownerPassword: 'Owner-Pass-123', userPassword: 'User-Pass-4567',
  };
  assert.deepEqual(
    await client.protectPdfKit('doc', 'b'.repeat(64), protection, { signal: controller.signal }),
    { kind: 'pdfkit-password-protection', artifact: { id: 'protected' } },
  );
  assert.equal(calls[1].path, '/api/documents/doc/pdfkit-protection');
  assert.equal(calls[1].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: 'macos-pdfkit-aes128-v1', sourceSha256: 'b'.repeat(64), protection,
  });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  for (const permissionsProfile of ['deny-all', 'print-only', 'copy-accessibility']) {
    await client.protectPdfKit('doc', 'b'.repeat(64), { ...protection, permissionsProfile });
    assert.equal(JSON.parse(calls.at(-1).options.body).protection.permissionsProfile, permissionsProfile);
  }
  for (const invalid of [
    { ...protection, extra: true },
    { ...protection, permissionsProfile: 'custom' },
    { ...protection, ownerPassword: 'short' },
    { ...protection, userPassword: 'A'.repeat(17) },
    { ...protection, userPassword: ' User-Pass-456' },
    { ...protection, userPassword: protection.ownerPassword },
    { ...protection, userPassword: 'Unicode-pass-€€' },
  ]) {
    assert.throws(() => client.protectPdfKit('doc', 'b'.repeat(64), invalid), TypeError);
  }
  assert.throws(() => client.protectPdfKit('doc', 'B'.repeat(64), protection), TypeError);
  assert.throws(() => client.protectPdfKit('doc', 'b'.repeat(64), protection, { signal: {} }), TypeError);
});

test('local host client removes protection only from an exact retained artifact binding', async () => {
  const calls = [];
  const controller = new AbortController();
  const documentId = '11111111-1111-4111-8111-111111111111';
  const sourceSha256 = 'b'.repeat(64);
  const protectedSha256 = 'd'.repeat(64);
  const validResult = protectionRemovalResult({ documentId, sourceSha256, protectedSha256 });
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: validResult }), { status: 201 });
  } });
  await client.bootstrap();
  const removal = {
    artifactId: '22222222-2222-4222-8222-222222222222',
    artifactSha256: protectedSha256, ownerPassword: 'Owner-Pass-123',
  };
  assert.deepEqual(
    await client.removePdfKitProtection(documentId, sourceSha256, removal, { signal: controller.signal }),
    validResult,
  );
  assert.equal(calls[1].path, `/api/documents/${documentId}/pdfkit-protection-removal`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: 'macos-pdfkit-remove-protection-v1', sourceSha256, removal,
  });
  for (const invalid of [
    { ...removal, extra: true },
    { ...removal, artifactId: 'unsafe' },
    { ...removal, artifactSha256: 'D'.repeat(64) },
    { ...removal, ownerPassword: 'short' },
    { ...removal, ownerPassword: ' Edge-Pass-123' },
  ]) {
    assert.throws(() => client.removePdfKitProtection(documentId, sourceSha256, invalid), TypeError);
  }
  assert.throws(() => client.removePdfKitProtection('doc', sourceSha256, removal), TypeError);
  assert.throws(() => client.removePdfKitProtection(documentId, 'B'.repeat(64), removal), TypeError);

  for (const mutate of [
    (result) => { result.protection.ownerAuthorizationVerified = false; },
    (result) => { result.protection.encrypted = true; },
    (result) => { result.sourceDigest = '0'.repeat(64); },
    (result) => { result.artifact.sha256 = '0'.repeat(64); },
    (result) => { result.artifact.id = removal.artifactId; },
    (result) => {
      result.artifact.sha256 = removal.artifactSha256;
      result.artifact.operation.validation.outputSha256 = removal.artifactSha256;
    },
    (result) => { result.artifact.operation.validation.validators.pop(); },
    (result) => { result.unexpected = true; },
  ]) {
    const malformed = structuredClone(validResult);
    mutate(malformed);
    const rejecting = new LocalHostClient({ fetchImpl: async (path) => {
      if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
      return new Response(JSON.stringify({ result: malformed }), { status: 201 });
    } });
    await rejecting.bootstrap();
    await assert.rejects(
      rejecting.removePdfKitProtection(documentId, sourceSha256, removal),
      { code: 'INVALID_LOCAL_HOST' },
    );
  }
});

test('local host client accepts only a fully bound metadata-sanitization result', async () => {
  const calls = [];
  const controller = new AbortController();
  const documentId = '11111111-1111-4111-8111-111111111111';
  const sourceSha256 = 'b'.repeat(64);
  const validResult = metadataSanitizationResult({ documentId, sourceSha256 });
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: validResult }), { status: 201 });
  } });
  await client.bootstrap();
  assert.deepEqual(
    await client.sanitizePdfKitMetadata(documentId, sourceSha256, { signal: controller.signal }),
    validResult,
  );
  assert.equal(calls[1].path, `/api/documents/${documentId}/sanitization`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: 'macos-pdfkit-metadata-sanitize-v1', sourceSha256,
  });
  assert.throws(() => client.sanitizePdfKitMetadata('doc', sourceSha256), TypeError);
  assert.throws(() => client.sanitizePdfKitMetadata(documentId, 'B'.repeat(64)), TypeError);
  assert.throws(
    () => client.sanitizePdfKitMetadata(documentId, sourceSha256, { signal: {} }),
    TypeError,
  );

  for (const mutate of [
    (result) => { result.sourceDigest = '0'.repeat(64); },
    (result) => { result.artifact.sha256 = sourceSha256; },
    (result) => { result.artifact.id = documentId; },
    (result) => { result.sanitization.removedCategories = ['xmp', 'document-info']; },
    (result) => { result.evidence.nativeMetadataAbsent = false; },
    (result) => { result.limitations[0] = 'All hidden content was removed.'; },
    (result) => { result.limitations.reverse(); },
    (result) => { result.artifact.operation.parameters.removedCategories = ['xmp']; },
    (result) => { result.artifact.operation.validation.validators.pop(); },
    (result) => { result.unexpected = true; },
  ]) {
    const malformed = structuredClone(validResult);
    mutate(malformed);
    const rejecting = new LocalHostClient({ fetchImpl: async (path) => {
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: malformed }), { status: 201 });
    } });
    await rejecting.bootstrap();
    await assert.rejects(
      rejecting.sanitizePdfKitMetadata(documentId, sourceSha256),
      { code: 'INVALID_LOCAL_HOST' },
    );
  }

  const wrapperDrift = new LocalHostClient({ fetchImpl: async (path) => {
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: validResult, unexpected: true }), { status: 201 });
  } });
  await wrapperDrift.bootstrap();
  await assert.rejects(
    wrapperDrift.sanitizePdfKitMetadata(documentId, sourceSha256),
    { code: 'INVALID_LOCAL_HOST' },
  );
});

