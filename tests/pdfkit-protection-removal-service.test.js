import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { PdfKitProtectionService } from '../scripts/host/pdfkit-protection-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const protectedArtifactId = '22222222-2222-4222-8222-222222222222';
const outputArtifactId = '33333333-3333-4333-8333-333333333333';
const originalBytes = Buffer.from('%PDF-1.7\noriginal source remains encrypted separately\n%%EOF\n');
const originalSha256 = createHash('sha256').update(originalBytes).digest('hex');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(16).fill(0)]);
const profiles = Object.freeze({
  'accessibility-only': Object.freeze({ mask: 32, raw: -3392 }),
  'copy-accessibility': Object.freeze({ mask: 48, raw: -3376 }),
  'deny-all': Object.freeze({ mask: 0, raw: -3904 }),
  'print-only': Object.freeze({ mask: 3, raw: -1852 }),
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function classicPdf({ permissions = null } = {}) {
  const chunks = ['%PDF-1.6\n'];
  const offsets = [0];
  const addObject = (number, body) => {
    offsets[number] = Buffer.byteLength(chunks.join(''), 'latin1');
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  };
  addObject(1, '<< /Type /Catalog >>');
  if (permissions !== null) {
    addObject(2, `<< /Filter /Standard /V 4 /R 4 /Length 128 /P ${permissions} /O <${'01'.repeat(32)}> /U <${'02'.repeat(32)}> /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /EncryptMetadata true >>`);
  }
  const size = permissions === null ? 2 : 3;
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let number = 1; number < size; number += 1) {
    chunks.push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R${permissions === null ? '' : ' /Encrypt 2 0 R'} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function protectedOperation(profile, artifactSha256) {
  return createOperationProvenance({
    type: 'pdfkit-password-protection',
    inputs: [{ documentId, sha256: originalSha256, role: 'source' }],
    parameters: { profile: 'macos-pdfkit-aes128-v1', permissionsProfile: profile },
    expected: { pageCount: 1, cipher: 'aes-128-cbc', sourceUnchanged: true },
    validation: {
      passed: true,
      validators: [
        'source-sha256', 'native-password-reopen',
        'classic-xref-encryption-dictionary', 'artifact-sha256',
      ],
      pageCount: 1,
      outputSha256: artifactSha256,
      permissionMask: profiles[profile].mask,
    },
  });
}

function createRemovalStore({ root, originalPath, artifact, state }) {
  return {
    getDocument: () => ({
      id: documentId, sha256: originalSha256, size: originalBytes.length,
      displayName: 'source.pdf', mediaType: 'application/pdf',
    }),
    getArtifact: (id) => {
      assert.equal(id, protectedArtifactId);
      return artifact;
    },
    getSourcePath: () => originalPath,
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
    promotePdfArtifact: async (_documentId, outputPath, options) => {
      state.promoted = { bytes: await readFile(outputPath), options };
      return {
        id: outputArtifactId, documentId, displayName: options.displayName,
        mediaType: 'application/pdf', size: state.promoted.bytes.length,
        sha256: sha256(state.promoted.bytes), operation: options.operation,
      };
    },
  };
}

function createRemovalPoppler(popplerInspection) {
  return {
    async execute(kind, parameters) {
      if (kind === 'inspect') {
        return {
          stdout: popplerInspection || [
            'Pages: 1', 'Encrypted: no', 'Form: none', 'JavaScript: no', 'Tagged: no',
          ].join('\n'),
          stderr: '', exitCode: 0,
        };
      }
      if (kind === 'listAttachments') {
        return { stdout: '0 embedded files\n', stderr: '', exitCode: 0 };
      }
      if (kind === 'inspectUrls') {
        return { stdout: 'Page Type URL\n', stderr: '', exitCode: 0 };
      }
      if (kind === 'renderPagePng') {
        await writeFile(`${parameters.outputPrefix}.png`, png, { mode: 0o600 });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected Poppler operation ${kind}`);
    },
  };
}

function createRemovalAdapter({
  profile, protectedSha256, outputSha256, outputBytes, receipt, adapterError, state,
}) {
  return {
    async protect() { throw new Error('not used by removal tests'); },
    async removeProtection({ workspacePath, requestBuffer }) {
      state.requestReference = requestBuffer;
      state.request = JSON.parse(requestBuffer.toString('utf8'));
      if (adapterError) throw adapterError;
      await writeFile(join(workspacePath, 'output.pdf'), outputBytes, { mode: 0o600 });
      return {
        schema: 'pdfkit-deprotection-receipt-v1', version: 1,
        operation: 'removeProtection', sourceSha256: protectedSha256,
        outputSha256, sourceProfile: profile, pageCount: 1,
        structuralSummary: {
          pageRotations: [0], annotationCounts: [0], annotationSubtypes: [[]],
        },
        ownerAuthorizationVerified: true, encryptionRemoved: true, reopenVerified: true,
        ...receipt,
      };
    },
  };
}

async function fixture({
  profile = 'accessibility-only',
  protectedBytes = classicPdf({ permissions: profiles[profile].raw }),
  outputBytes = classicPdf(), receipt = {}, adapterError = null,
  popplerInspection = '', tamperOperation = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-protection-removal-'));
  const originalPath = join(root, 'original.pdf');
  const protectedPath = join(root, 'protected.pdf');
  await writeFile(originalPath, originalBytes, { mode: 0o600 });
  await writeFile(protectedPath, protectedBytes, { mode: 0o600 });
  const protectedSha256 = sha256(protectedBytes);
  const outputSha256 = sha256(outputBytes);
  let operation = protectedOperation(profile, protectedSha256);
  if (tamperOperation) operation = tamperOperation(operation);
  const state = {
    requestReference: null, request: null, cleaned: false, promoted: null, verified: 0,
  };
  const artifact = {
    id: protectedArtifactId,
    documentId,
    displayName: 'source-protected.pdf',
    mediaType: 'application/pdf',
    size: protectedBytes.length,
    sha256: protectedSha256,
    operation,
    createdAt: new Date(0).toISOString(),
    filePath: protectedPath,
  };
  const store = createRemovalStore({ root, originalPath, artifact, state });
  const pdfService = {
    inspect: async () => ({}), inspectStructure: async () => ({}),
    listAttachments: async () => [], verifySignatures: async () => ({}),
  };
  const poppler = createRemovalPoppler(popplerInspection);
  const adapter = createRemovalAdapter({
    profile, protectedSha256, outputSha256, outputBytes, receipt, adapterError, state,
  });
  return {
    root,
    service: new PdfKitProtectionService({ store, pdfService, poppler, adapter }),
    input: {
      artifactId: protectedArtifactId,
      artifactSha256: protectedSha256,
      ownerPassword: 'Owner-Pass-123',
    },
    state: () => ({ ...state }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test('fixed protection removal admits every retained profile and promotes only a verified cleartext copy', async (context) => {
  for (const profile of Object.keys(profiles)) {
    const setup = await fixture({ profile }); context.after(setup.dispose);
    const result = await setup.service.removeProtection(documentId, setup.input, { sourceSha256: originalSha256 });
    assert.equal(result.kind, 'pdfkit-protection-removal');
    assert.equal(result.protection.sourceProtectionProfile, profile);
    assert.equal(result.protection.ownerAuthorizationVerified, true);
    assert.equal(result.protection.encrypted, false);
    assert.equal(result.evidence.finalTrailerUnencrypted, true);
    assert.equal(result.evidence.encryptedSourceRetained, true);
    assert.equal(result.artifact.displayName, 'source-protected-unprotected.pdf');
    const state = setup.state();
    assert.equal(state.cleaned, true);
    assert.equal(state.verified, 2);
    assert.equal(state.request.operation, 'removeProtection');
    assert.equal(state.request.removal.sourceProfile, profile);
    assert.equal(state.requestReference.every((byte) => byte === 0), true);
    assert.equal(state.promoted.options.expectedSha256, result.artifact.sha256);
    assert.equal(state.promoted.options.operation.type, 'pdfkit-protection-removal');
    assert.equal(state.promoted.options.operation.parameters.protectedArtifactSha256, setup.input.artifactSha256);
    assert.equal(state.promoted.options.operation.validation.passed, true);
    assert.equal((await stat(join(setup.root, 'protected.pdf'))).mode & 0o777, 0o600);
    for (const publicValue of [result, state.promoted.options.operation]) {
      assert.doesNotMatch(JSON.stringify(publicValue), /Owner-Pass-123/);
    }
  }
});

test('fixed protection removal rejects invalid credentials, artifact bindings, and unsupported source envelopes', async (context) => {
  const invalidSetup = await fixture(); context.after(invalidSetup.dispose);
  for (const invalid of [
    { ...invalidSetup.input, extra: true },
    { ...invalidSetup.input, artifactId: 'not-an-id' },
    { ...invalidSetup.input, ownerPassword: 'short' },
    { ...invalidSetup.input, ownerPassword: ' Edge-Pass-123' },
  ]) {
    await assert.rejects(
      invalidSetup.service.removeProtection(documentId, invalid, { sourceSha256: originalSha256 }),
      { code: 'INVALID_PDFKIT_PROTECTION_REMOVAL_OPTIONS', status: 400 },
    );
  }
  await assert.rejects(
    invalidSetup.service.removeProtection(documentId, invalidSetup.input, { sourceSha256: '0'.repeat(64) }),
    { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
  );
  await assert.rejects(
    invalidSetup.service.removeProtection(
      documentId, { ...invalidSetup.input, artifactSha256: '0'.repeat(64) },
      { sourceSha256: originalSha256 },
    ),
    { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
  );

  const wrongEnvelope = await fixture({
    profile: 'print-only', protectedBytes: classicPdf({ permissions: -3392 }),
  });
  context.after(wrongEnvelope.dispose);
  await assert.rejects(
    wrongEnvelope.service.removeProtection(documentId, wrongEnvelope.input, { sourceSha256: originalSha256 }),
    { code: 'PDFKIT_PROTECTION_REMOVAL_SOURCE_UNSUPPORTED', status: 422 },
  );

  const inconsistentPageProvenance = await fixture({
    tamperOperation: (operation) => ({
      ...operation,
      expected: { ...operation.expected, pageCount: 2 },
    }),
  });
  context.after(inconsistentPageProvenance.dispose);
  await assert.rejects(
    inconsistentPageProvenance.service.removeProtection(
      documentId, inconsistentPageProvenance.input, { sourceSha256: originalSha256 },
    ),
    { code: 'PDFKIT_PROTECTION_REMOVAL_SOURCE_UNSUPPORTED', status: 422 },
  );

  const rejection = new Error('credential details must not escape');
  rejection.code = 'MUTATION_FAILED';
  const rejected = await fixture({ adapterError: rejection }); context.after(rejected.dispose);
  await assert.rejects(
    rejected.service.removeProtection(documentId, rejected.input, { sourceSha256: originalSha256 }),
    (error) => error.code === 'PDFKIT_PROTECTION_REMOVAL_REJECTED'
      && error.cause === undefined && !JSON.stringify(error).includes('credential details'),
  );
  assert.equal(rejected.state().requestReference.every((byte) => byte === 0), true);
  assert.equal(rejected.state().cleaned, true);
});

test('fixed protection removal rejects native receipts and outputs that disagree with independent evidence', async (context) => {
  for (const [options, code] of [
    [{ receipt: { ownerAuthorizationVerified: false } }, 'PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID'],
    [{ receipt: { pageCount: 2 } }, 'PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID'],
    [{
      receipt: { pageCount: 2 },
      popplerInspection: 'Pages: 2\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no',
    }, 'PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID'],
    [{ outputBytes: classicPdf({ permissions: -3392 }) }, 'PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID'],
    [{ popplerInspection: 'Pages: 1\nEncrypted: yes\nForm: none\nJavaScript: no\nTagged: no' }, 'PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID'],
  ]) {
    const setup = await fixture(options); context.after(setup.dispose);
    await assert.rejects(
      setup.service.removeProtection(documentId, setup.input, { sourceSha256: originalSha256 }),
      { code },
    );
    assert.equal(setup.state().promoted, null);
    assert.equal(setup.state().cleaned, true);
    assert.equal(setup.state().requestReference.every((byte) => byte === 0), true);
  }
});
