import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PdfKitSanitizationService } from '../scripts/host/pdfkit-sanitization-service.mjs';
import { buildMetadataSanitizationRequest, receiptMatchesMetadataContract } from '../scripts/host/pdfkit-sanitization-contract.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
function closedClassicPdf() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n',
  ];
  let value = '%PDF-1.7\n%\xFF\xFF\xFF\xFF\n'; const offsets = [];
  for (const object of objects) { offsets.push(Buffer.byteLength(value, 'latin1')); value += object; }
  const xref = Buffer.byteLength(value, 'latin1');
  value += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value, 'latin1');
}

const sourceBytes = Buffer.from(`%PDF-1.7\n${'private metadata source '.repeat(4)}\n%%EOF\n`);
const outputBytes = closedClassicPdf();
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const outputSha256 = createHash('sha256').update(outputBytes).digest('hex');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(16).fill(0)]);

test('metadata sanitization contract fixes native request fields and receipt identity', () => {
  const request = JSON.parse(buildMetadataSanitizationRequest(sourceSha256, { maxPages: 100 }).toString('utf8'));
  assert.deepEqual(request, { version: 1, operation: 'sanitizeMetadata', inputFilename: 'input.pdf', outputFilename: 'output.pdf', sourceSha256, limits: { maxPages: 100 } });
  const source = { sha256: sourceSha256 };
  const receipt = { sourceSha256, outputSha256, pageCount: 2, observedCategories: ['document-info'], freshDocumentCopy: true, metadataAbsent: true, contentSnapshotMatched: true, reopenVerified: true };
  assert.equal(receiptMatchesMetadataContract(receipt, source, ['document-info'], 2), true);
  assert.equal(receiptMatchesMetadataContract({ ...receipt, outputSha256: sourceSha256 }, source, ['document-info'], 2), false);
});

function pdfInfo({ output = false, unsafe = null } = {}) {
  if (unsafe) return `Pages: 2\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\n${unsafe}\n`;
  return output
    ? 'Pages: 2\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\nCustom Metadata: no\nMetadata Stream: no\n'
    : 'Pages: 2\nTitle: Private title\nProducer: Private producer\nEncrypted: no\nForm: none\nJavaScript: no\nTagged: no\nCustom Metadata: yes\nMetadata Stream: yes\n';
}

function createSanitizationStore({ root, sourcePath, cleanupFailureCall, state }) {
  return {
    getDocument: () => ({
      id: documentId,
      sha256: sourceSha256,
      size: sourceBytes.length,
      displayName: 'private-source.pdf',
      mediaType: 'application/pdf',
    }),
    getSourcePath: () => sourcePath,
    verifySource: async () => {
      state.verified += 1;
      assert.equal(
        createHash('sha256').update(await readFile(sourcePath)).digest('hex'),
        sourceSha256,
      );
    },
    createJobWorkspace: async () => {
      const workspace = await mkdtemp(join(root, 'job-'));
      await chmod(workspace, 0o700);
      return workspace;
    },
    cleanupJob: (workspace) => {
      state.cleaned += 1;
      if (state.cleaned === cleanupFailureCall) throw new Error('private cleanup failure');
      return rm(workspace, { recursive: true, force: true });
    },
    promotePdfArtifact: async (_documentId, outputPath, options) => {
      const bytes = await readFile(outputPath);
      state.promoted = { bytes, options };
      return {
        id: artifactId, documentId, displayName: options.displayName,
        mediaType: 'application/pdf', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        operation: options.operation, createdAt: new Date(0).toISOString(),
      };
    },
    deleteArtifact: async (id) => { state.deleted = id; },
  };
}

function createSanitizationPoppler(options) {
  return {
    async execute(operation, parameters) {
      const output = parameters.input?.endsWith('output.pdf') ?? false;
      if (operation === 'inspect') {
        return { stdout: output ? options.outputInfo : options.sourceInfo, stderr: '', exitCode: 0 };
      }
      if (operation === 'inspectMetadata') {
        return { stdout: output ? options.outputXmp : options.sourceXmp, stderr: '', exitCode: 0 };
      }
      if (operation === 'inspectCustomMetadata') {
        return { stdout: output ? options.outputCustom : options.sourceCustom, stderr: '', exitCode: 0 };
      }
      if (operation === 'listAttachments') return { stdout: '0 embedded files\n', stderr: '', exitCode: 0 };
      if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n', stderr: '', exitCode: 0 };
      if (operation === 'inspectDestinations') {
        return { stdout: 'Page  Destination                 Name\n', stderr: '', exitCode: 0 };
      }
      if (operation === 'verifySignatures') {
        if (options.signatureValidation) {
          return {
            stdout: [
              `Digital Signature Info of: ${parameters.input}`, 'Signature #1:',
              '  - Signing Hash Algorithm: SHA-256',
              '  - Signature Type: adbe.pkcs7.detached',
              '  - Signed Ranges: [0 - 500], [4096 - 8191]',
              '  - Total document signed',
              `  - Signature Validation: ${options.signatureValidation}`, '',
            ].join('\n'),
            stderr: '', exitCode: 0,
          };
        }
        return {
          stdout: `File '${parameters.input}' does not contain any signatures\n`,
          stderr: '', exitCode: 0,
        };
      }
      if (operation === 'renderPagePng') {
        await writeFile(
          `${parameters.outputPrefix}.png`,
          options.invalidPng ? Buffer.from('not a png') : png,
          { mode: 0o600 },
        );
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      assert.fail(`unexpected Poppler operation ${operation}`);
    },
  };
}

function createSanitizationAdapter(options, state) {
  return {
    async sanitizeMetadata({ workspacePath, requestBuffer }) {
      state.requestReference = requestBuffer;
      state.observedRequest = JSON.parse(requestBuffer.toString('utf8'));
      if (options.adapterError) throw options.adapterError;
      await writeFile(join(workspacePath, 'output.pdf'), options.outputBytes ?? outputBytes, { mode: 0o600 });
      if (options.unexpectedWorkspaceFile) {
        await writeFile(join(workspacePath, 'unexpected.txt'), 'unsafe', { mode: 0o600 });
      }
      return {
        schema: 'pdfkit-metadata-sanitization-receipt-v1',
        version: 1, operation: 'sanitizeMetadata', sourceSha256, outputSha256,
        pageCount: 2, observedCategories: ['document-info', 'custom-info', 'xmp'],
        freshDocumentCopy: true, metadataAbsent: true,
        contentSnapshotMatched: true, reopenVerified: true,
        ...options.receipt,
      };
    },
  };
}

async function fixture({
  sourceInfo = pdfInfo(), sourceXmp = '<private>source xmp value</private>',
  sourceCustom = 'Department: Secret division\n', outputInfo = pdfInfo({ output: true }),
  outputXmp = '', outputCustom = '', receipt = {}, adapterError = null,
  unexpectedWorkspaceFile = false, invalidPng = false, cleanupFailureCall = null,
  signatureValidation = null, outputBytes: adapterOutputBytes = null,
} = {}) {
  const options = {
    sourceInfo, sourceXmp, sourceCustom, outputInfo, outputXmp, outputCustom,
    receipt, adapterError, unexpectedWorkspaceFile, invalidPng, signatureValidation, outputBytes: adapterOutputBytes,
  };
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-metadata-sanitization-'));
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const state = {
    cleaned: 0, verified: 0, observedRequest: null, requestReference: null,
    promoted: null, deleted: null,
  };
  const store = {
    ...createSanitizationStore({ root, sourcePath, cleanupFailureCall, state }),
  };
  return {
    root,
    service: new PdfKitSanitizationService({
      store,
      poppler: createSanitizationPoppler(options),
      adapter: createSanitizationAdapter(options, state),
    }),
    state: () => ({ ...state }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test('fixed metadata sanitization promotes only a category-bound metadata-free fresh copy', async (context) => {
  const setup = await fixture();
  context.after(setup.dispose);
  const result = await setup.service.sanitizeMetadata(documentId, { sourceSha256 });
  assert.equal(result.kind, 'pdfkit-metadata-sanitization');
  assert.deepEqual(result.sanitization.removedCategories, ['document-info', 'custom-info', 'xmp']);
  assert.equal(result.evidence.nativeFreshDocumentCopy, true);
  assert.equal(result.evidence.popplerMetadataAbsent, true);
  assert.equal(result.evidence.outputUnsigned, true);
  assert.equal(result.artifact.sha256, outputSha256);
  assert.equal(result.artifact.displayName, 'private-source-metadata-sanitized.pdf');
  const state = setup.state();
  assert.equal(state.cleaned, 2);
  assert.equal(state.verified, 2);
  assert.equal(state.deleted, null);
  assert.equal(state.requestReference.every((byte) => byte === 0), true);
  assert.deepEqual(state.observedRequest, {
    version: 1,
    operation: 'sanitizeMetadata',
    inputFilename: 'input.pdf',
    outputFilename: 'output.pdf',
    sourceSha256,
    limits: {
      maxPages: 100,
      maxAnnotationsPerPage: 50,
      maxWidgetsPerPage: 0,
      maxOutlineDepth: 8,
      maxOutlineItems: 200,
    },
  });
  assert.equal(state.promoted.options.operation.type, 'pdfkit-metadata-sanitization');
  assert.deepEqual(
    state.promoted.options.operation.parameters.removedCategories,
    ['document-info', 'custom-info', 'xmp'],
  );
  assert.equal(state.promoted.options.operation.validation.passed, true);
  for (const publicValue of [result, state.promoted.options.operation]) {
    assert.doesNotMatch(JSON.stringify(publicValue), /Private title|Private producer|Secret division|source xmp value/);
  }
});

test('fixed metadata sanitization rejects stale, unsafe, signed, and no-op sources before promotion', async (context) => {
  const setup = await fixture();
  context.after(setup.dispose);
  await assert.rejects(
    setup.service.sanitizeMetadata(documentId, { sourceSha256: '0'.repeat(64) }),
    { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
  );

  const noMetadata = await fixture({
    sourceInfo: pdfInfo({ output: true }), sourceXmp: '', sourceCustom: '',
  });
  context.after(noMetadata.dispose);
  await assert.rejects(
    noMetadata.service.sanitizeMetadata(documentId, { sourceSha256 }),
    { code: 'PDFKIT_SANITIZATION_NOT_REQUIRED', status: 422 },
  );
  assert.equal(noMetadata.state().promoted, null);

  for (const unsafe of ['Encrypted: yes', 'Form: AcroForm', 'JavaScript: yes', 'Tagged: yes']) {
    const unsafeSource = await fixture({ sourceInfo: pdfInfo({ unsafe }) });
    context.after(unsafeSource.dispose);
    await assert.rejects(
      unsafeSource.service.sanitizeMetadata(documentId, { sourceSha256 }),
      { code: 'PDFKIT_SANITIZATION_SOURCE_UNSUPPORTED', status: 422 },
    );
    assert.equal(unsafeSource.state().promoted, null);
  }

  for (const signatureValidation of [
    'Signature is Valid.',
    'Signature has not yet been verified.',
  ]) {
    const signedSource = await fixture({ signatureValidation });
    context.after(signedSource.dispose);
    await assert.rejects(
      signedSource.service.sanitizeMetadata(documentId, { sourceSha256 }),
      { code: 'PDFKIT_SANITIZATION_SOURCE_UNSUPPORTED', status: 422 },
    );
    assert.equal(signedSource.state().promoted, null);
  }
});

test('fixed metadata sanitization rejects native, workspace, and independent postflight disagreement', async (context) => {
  const cases = [
    [{ receipt: { observedCategories: ['document-info'] } }, 'PDFKIT_SANITIZATION_OUTPUT_INVALID'],
    [{ receipt: { metadataAbsent: false } }, 'PDFKIT_SANITIZATION_OUTPUT_INVALID'],
    [{ outputInfo: `${pdfInfo({ output: true })}Producer: residue\n` }, 'PDFKIT_SANITIZATION_OUTPUT_INVALID'],
    [{ outputXmp: '<residue />' }, 'PDFKIT_SANITIZATION_OUTPUT_INVALID'],
    [{ outputCustom: 'Residue: present\n' }, 'PDFKIT_SANITIZATION_OUTPUT_INVALID'],
    [{ unexpectedWorkspaceFile: true }, 'PDFKIT_SANITIZATION_WORKSPACE_INVALID'],
    [{ invalidPng: true }, 'PDFKIT_SANITIZATION_OUTPUT_INVALID'],
    [{ outputBytes: Buffer.from('%PDF-1.7\nold private output\n%%EOF\n') }, 'PDFKIT_SANITIZATION_OUTPUT_INVALID'],
  ];
  for (const [options, code] of cases) {
    const setup = await fixture(options);
    context.after(setup.dispose);
    await assert.rejects(
      setup.service.sanitizeMetadata(documentId, { sourceSha256 }),
      { code },
    );
    assert.equal(setup.state().promoted, null);
    assert.equal(setup.state().cleaned, 2);
    assert.equal(setup.state().requestReference.every((byte) => byte === 0), true);
  }

  const rejection = new Error('private metadata must not escape');
  rejection.code = 'MUTATION_FAILED';
  const nativeRejected = await fixture({ adapterError: rejection });
  context.after(nativeRejected.dispose);
  await assert.rejects(
    nativeRejected.service.sanitizeMetadata(documentId, { sourceSha256 }),
    (error) => error.code === 'PDFKIT_SANITIZATION_SOURCE_UNSUPPORTED'
      && !JSON.stringify(error).includes('private metadata'),
  );
  assert.equal(nativeRejected.state().requestReference.every((byte) => byte === 0), true);
});

test('fixed metadata sanitization attempts every cleanup and revokes a promoted artifact on cleanup failure', async (context) => {
  const setup = await fixture({ cleanupFailureCall: 1 });
  context.after(setup.dispose);
  await assert.rejects(
    setup.service.sanitizeMetadata(documentId, { sourceSha256 }),
    (error) => error.code === 'PDFKIT_SANITIZATION_CLEANUP_FAILED'
      && error.status === 500
      && !JSON.stringify(error).includes('private cleanup failure'),
  );
  const state = setup.state();
  assert.equal(state.cleaned, 2);
  assert.notEqual(state.promoted, null);
  assert.equal(state.deleted, artifactId);
});
