import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfKitProtectionService } from '../scripts/host/pdfkit-protection-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceBytes = Buffer.from('%PDF-1.7\nfixed protection source\n%%EOF\n');
const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
const permissionProfiles = Object.freeze({
  'accessibility-only': Object.freeze({ mask: 32, raw: -3392, permissions: Object.freeze(['contentAccessibility']) }),
  'copy-accessibility': Object.freeze({ mask: 48, raw: -3376, permissions: Object.freeze(['copying', 'contentAccessibility']) }),
  'deny-all': Object.freeze({ mask: 0, raw: -3904, permissions: Object.freeze([]) }),
  'print-only': Object.freeze({ mask: 3, raw: -1852, permissions: Object.freeze(['printing']) }),
});

function classicEncryptedPdf({ permissions = -3392 } = {}) {
  const chunks = ['%PDF-1.6\n'];
  const offsets = [0];
  const addObject = (number, body) => {
    offsets[number] = Buffer.byteLength(chunks.join(''), 'latin1');
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  };
  addObject(1, '<< /Type /Catalog >>');
  addObject(2, `<< /Filter /Standard /V 4 /R 4 /Length 128 /P ${permissions} /O <${'01'.repeat(32)}> /U <${'02'.repeat(32)}> /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /EncryptMetadata true >>`);
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 3\n0000000000 65535 f \n');
  chunks.push(`${String(offsets[1]).padStart(10, '0')} 00000 n \n`);
  chunks.push(`${String(offsets[2]).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 3 /Root 1 0 R /Encrypt 2 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function protection(permissionsProfile = 'accessibility-only') {
  return {
    permissionsProfile,
    ownerPassword: 'Owner-Pass-123',
    userPassword: 'User-Pass-4567',
  };
}

function createProtectionStore({ root, sourcePath, state }) {
  return {
    getDocument: () => ({
      id: documentId, sha256: sourceDigest, size: sourceBytes.length, displayName: 'source.pdf',
    }),
    getSourcePath: () => sourcePath,
    getArtifact: () => { throw new Error('not used by protection creation tests'); },
    verifySource: async () => { state.verified += 1; },
    createJobWorkspace: async () => {
      const workspace = await mkdtemp(join(root, 'job-'));
      await chmod(workspace, 0o700);
      return workspace;
    },
    cleanupJob: async (workspace) => {
      state.cleaned = true;
      await rm(workspace, { recursive: true, force: true });
    },
    promotePdfArtifact: async (_id, outputPath, options) => {
      state.promoted = { bytes: await readFile(outputPath), options };
      return {
        id: '22222222-2222-4222-8222-222222222222', documentId,
        displayName: options.displayName, mediaType: 'application/pdf',
        size: state.promoted.bytes.length,
        sha256: createHash('sha256').update(state.promoted.bytes).digest('hex'),
        operation: options.operation,
      };
    },
  };
}

function createProtectionInspection({ inspection, signatures, attachments, urls }) {
  return {
    inspect: async () => ({
      pageCount: 1, encrypted: 'no', form: 'none', javascript: 'no', tagged: 'no', ...inspection,
    }),
    verifySignatures: async () => ({
      schemaVersion: 1,
      profile: 'poppler-offline-integrity-v1',
      sourceSha256: sourceDigest,
      status: 'unsigned',
      count: 0,
      signatureCount: 0,
      signatures: [],
      limitations: [],
      ...signatures,
    }),
    listAttachments: async () => attachments,
    inspectStructure: async () => ({
      sourceDigest, pageRange: { firstPage: 1, lastPage: 1, truncated: false }, urls,
    }),
  };
}

function createProtectionPoppler(popplerMode) {
  return {
    async execute(operation) {
      assert.equal(operation, 'inspect');
      if (popplerMode === 'success') return { stdout: 'Pages: 1\n', stderr: '', exitCode: 0 };
      const error = new Error('password required');
      Object.assign(error, {
        exitCode: 1,
        stdout: popplerMode === 'stdout' ? 'unexpected' : '',
        stderr: popplerMode === 'diagnostic' ? 'Incorrect password\n' : 'Command Line Error: Incorrect password\n',
      });
      throw error;
    },
  };
}

function createProtectionAdapter({
  permissionsProfile, outputBytes, outputDigest, receipt, unsafeOutput, state,
}) {
  return {
    async removeProtection() { throw new Error('not used by protection creation tests'); },
    async protect({ workspacePath, requestBuffer }, options) {
      state.requestReference = requestBuffer;
      state.observed = {
        request: JSON.parse(requestBuffer.toString('utf8')),
        inputMode: (await stat(join(workspacePath, 'input.pdf'))).mode & 0o777,
        options,
      };
      if (options.signal.aborted) throw new Error('cancelled');
      await writeFile(join(workspacePath, 'output.pdf'), outputBytes, { mode: 0o600 });
      if (unsafeOutput) await writeFile(join(workspacePath, 'unexpected.txt'), 'unsafe', { mode: 0o600 });
      return {
        schema: 'pdfkit-protection-receipt-v1', version: 1, operation: 'protect',
        sourceSha256: sourceDigest, outputSha256: outputDigest, profile: permissionsProfile,
        effectivePermissions: permissionProfiles[permissionsProfile]?.permissions ?? [],
        effectivePermissionMask: permissionProfiles[permissionsProfile]?.mask ?? 0,
        pageCount: 1,
        structuralSummary: { pageRotations: [0], annotationCounts: [0], annotationSubtypes: [[]] },
        ...receipt,
      };
    },
  };
}

async function fixture({
  permissionsProfile = 'accessibility-only',
  outputBytes = classicEncryptedPdf({ permissions: permissionProfiles[permissionsProfile]?.raw ?? -3904 }),
  inspection = {}, signatures = {}, attachments = [], urls = [], popplerMode = 'reject',
  receipt = {}, unsafeOutput = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-protection-service-'));
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const outputDigest = createHash('sha256').update(outputBytes).digest('hex');
  const state = {
    verified: 0, cleaned: false, observed: null, requestReference: null, promoted: null,
  };
  const store = createProtectionStore({ root, sourcePath, state });
  const pdfService = createProtectionInspection({ inspection, signatures, attachments, urls });
  const poppler = createProtectionPoppler(popplerMode);
  const adapter = createProtectionAdapter({
    permissionsProfile, outputBytes, outputDigest, receipt, unsafeOutput, state,
  });
  return {
    root,
    service: new PdfKitProtectionService({ store, pdfService, poppler, adapter }),
    state: () => ({ ...state }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test('fixed PDFKit protection keeps passwords off disk, validates AESV2, and promotes a digest-bound artifact', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const result = await setup.service.protect(documentId, protection(), { sourceSha256: sourceDigest });
  assert.equal(result.kind, 'pdfkit-password-protection');
  assert.equal(result.protection.cipher, 'AES-128-CBC');
  assert.equal(result.protection.permissionsProfile, 'accessibility-only');
  assert.equal(result.evidence.encryptionDictionaryValidated, true);
  assert.equal(result.evidence.popplerRejectedUnauthenticatedOpen, true);
  assert.equal(result.artifact.displayName, 'source-protected.pdf');
  const state = setup.state();
  assert.equal(state.verified, 2);
  assert.equal(state.cleaned, true);
  assert.equal(state.observed.inputMode, 0o400);
  assert.deepEqual(state.observed.request.protection, {
    profile: 'accessibility-only', ownerPassword: 'Owner-Pass-123', userPassword: 'User-Pass-4567',
  });
  assert.deepEqual(state.observed.options.timeoutMs, 30_000);
  assert.equal(state.requestReference.every((byte) => byte === 0), true);
  assert.equal(state.promoted.options.expectedSha256, result.artifact.sha256);
  assert.equal(state.promoted.options.operation.type, 'pdfkit-password-protection');
  assert.deepEqual({ ...state.promoted.options.operation.parameters }, {
    profile: 'macos-pdfkit-aes128-v1', permissionsProfile: 'accessibility-only',
  });
  for (const publicValue of [result, state.promoted.options.operation]) {
    assert.doesNotMatch(JSON.stringify(publicValue), /Owner-Pass-123|User-Pass-4567/);
  }
});

test('fixed PDFKit protection accepts only four closed permission profiles', async (context) => {
  for (const [profile, expected] of Object.entries(permissionProfiles)) {
    const setup = await fixture({ permissionsProfile: profile }); context.after(setup.dispose);
    const result = await setup.service.protect(documentId, protection(profile), { sourceSha256: sourceDigest });
    assert.equal(result.protection.permissionsProfile, profile);
    assert.deepEqual(result.protection.effectivePermissions, expected.permissions);
    assert.equal(setup.state().observed.request.protection.profile, profile);
    assert.equal(setup.state().promoted.options.operation.validation.permissionMask, expected.mask);
    assert.doesNotMatch(JSON.stringify(result), /Owner-Pass-123|User-Pass-4567/);
  }
  const setup = await fixture(); context.after(setup.dispose);
  for (const invalid of [
    { ...protection(), extra: true },
    protection('custom'),
    { ...protection(), userPassword: 'short' },
    { ...protection(), userPassword: 'A'.repeat(17) },
    { ...protection(), userPassword: ' User-Pass-456' },
    { ...protection(), ownerPassword: 'User-Pass-4567' },
    { ...protection(), userPassword: 'Unicode-pass-€€' },
  ]) {
    await assert.rejects(setup.service.protect(documentId, invalid, { sourceSha256: sourceDigest }), {
      code: 'INVALID_PDFKIT_PROTECTION_OPTIONS', status: 400,
    });
  }
});

test('fixed PDFKit protection fails closed for unsafe source classifications', async (context) => {
  const cases = [
    { inspection: { encrypted: 'yes' } },
    { inspection: { form: 'AcroForm' } },
    { inspection: { javascript: 'yes' } },
    { inspection: { tagged: 'yes' } },
    { signatures: { status: 'valid', count: 1, signatureCount: 1 } },
    { signatures: { status: 'indeterminate', count: null, signatureCount: null } },
    { attachments: [{ number: 1, name: 'private.txt' }] },
    { urls: [{ page: 1, type: 'URI', url: 'https://example.invalid' }] },
  ];
  for (const options of cases) {
    const setup = await fixture(options); context.after(setup.dispose);
    await assert.rejects(
      setup.service.protect(documentId, protection(), { sourceSha256: sourceDigest }),
      (error) => error.status === 422,
    );
    assert.equal(setup.state().observed, null);
  }
  const setup = await fixture(); context.after(setup.dispose);
  await assert.rejects(setup.service.protect(documentId, protection(), { sourceSha256: '0'.repeat(64) }), {
    code: 'SOURCE_VERSION_MISMATCH', status: 409,
  });
});

test('fixed PDFKit protection rejects envelope, receipt, Poppler, and workspace validation disagreements', async (context) => {
  for (const [options, code] of [
    [{ outputBytes: classicEncryptedPdf({ permissions: -3904 }) }, 'PDFKIT_ENCRYPTION_INVALID'],
    [{ receipt: { pageCount: 2 } }, 'PDFKIT_OUTPUT_INVALID'],
    [{ popplerMode: 'success' }, 'PDFKIT_PASSWORD_VALIDATION_FAILED'],
    [{ popplerMode: 'diagnostic' }, 'PDFKIT_PASSWORD_VALIDATION_FAILED'],
    [{ popplerMode: 'stdout' }, 'PDFKIT_PASSWORD_VALIDATION_FAILED'],
    [{ unsafeOutput: true }, 'PDFKIT_WORKSPACE_INVALID'],
  ]) {
    const setup = await fixture(options); context.after(setup.dispose);
    await assert.rejects(
      setup.service.protect(documentId, protection(), { sourceSha256: sourceDigest }),
      { code },
    );
    assert.equal(setup.state().cleaned, true);
    assert.equal(setup.state().promoted, null);
    assert.equal(setup.state().requestReference?.every((byte) => byte === 0), true);
  }
});

test('fixed PDFKit protection rejects a receipt or raw permission value from a different preset', async (context) => {
  const mismatches = [
    { permissionsProfile: 'print-only', outputBytes: classicEncryptedPdf({ permissions: -3392 }), code: 'PDFKIT_ENCRYPTION_INVALID' },
    { permissionsProfile: 'copy-accessibility', receipt: { effectivePermissionMask: 32 }, code: 'PDFKIT_OUTPUT_INVALID' },
    { permissionsProfile: 'deny-all', receipt: { effectivePermissions: ['printing'] }, code: 'PDFKIT_OUTPUT_INVALID' },
  ];
  for (const mismatch of mismatches) {
    const setup = await fixture(mismatch); context.after(setup.dispose);
    await assert.rejects(
      setup.service.protect(documentId, protection(mismatch.permissionsProfile), { sourceSha256: sourceDigest }),
      { code: mismatch.code },
    );
  }
});

test('fixed PDFKit protection maps cancellation without retaining secret request bytes', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    setup.service.protect(documentId, protection(), { sourceSha256: sourceDigest, signal: controller.signal }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
  assert.equal(setup.state().requestReference?.every((byte) => byte === 0), true);
  assert.equal(setup.state().cleaned, true);
});
