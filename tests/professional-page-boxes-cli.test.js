import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runProfessionalCapabilityCommand } from '../scripts/cli/commands/professional-capability.mjs';

const CAPABILITY_ID = 'pages.page-boxes';
const PAGE = 2;

function requestFor(sourceSha256, overrides = {}) {
  return Object.freeze({
    sourceSha256,
    page: PAGE,
    boxType: 'crop',
    box: Object.freeze({
      left: 20,
      bottom: 20,
      right: 580,
      top: 760,
    }),
    ...overrides,
  });
}

function makeArtifact({ id, documentId, sha256, filePath }) {
  return Object.freeze({
    id,
    documentId,
    mediaType: 'application/pdf',
    size: 14,
    sha256,
    filePath,
  });
}

function resultFor(sourceSha256, boxType = 'crop') {
  const outputSha256 = createHash('sha256').update(`OUTPUT-${boxType}`).digest('hex');
  const artifact = makeArtifact({
    id: '11111111-1111-4111-8111-111111111111',
    documentId: '22222222-2222-4222-8222-222222222222',
    sha256: outputSha256,
    filePath: '/tmp/artifact.pdf',
  });
  return Object.freeze({
    capabilityId: CAPABILITY_ID,
    outputSha256,
    artifact,
    pdf: Buffer.from('private PDF bytes'),
    page: PAGE,
    boxType,
    box: Object.freeze({
      left: 20,
      bottom: 20,
      right: 580,
      top: 760,
    }),
    serviceReceipt: {
      artifact,
      sourceSha256,
      operation: 'source-bound-pdfkit-crop-box',
    },
  });
}

test('professional page-boxes CLI parses source/request/output contract', () => {
  const parsed = parseCliArguments([
    'professional-capability', 'input.pdf', '--capability-id', CAPABILITY_ID,
    '--request', 'request.json', '--output', 'output.pdf',
  ]);
  assert.equal(parsed.capabilityId, CAPABILITY_ID);
  assert.equal(parsed.input, 'input.pdf');
  assert.equal(parsed.requestPath, 'request.json');
  assert.equal(parsed.output, 'output.pdf');
});

test('professional page-boxes CLI performs source-bound operation and emits privacy-safe receipt', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  const result = resultFor(sourceSha256, 'crop');
  const emitted = [];
  const copied = [];
  const deleted = [];
  await runProfessionalCapabilityCommand({
    professionalCapabilities: {
      async deliverPageOrganizationSourceBound(capabilityId, documentId, request, options) {
        assert.equal(capabilityId, CAPABILITY_ID);
        assert.equal(documentId, '22222222-2222-4222-8222-222222222222');
        assert.equal(request.sourceSha256, sourceSha256);
        assert.equal(request.page, PAGE);
        assert.equal(request.boxType, 'crop');
        assert.equal(request.box.left, 20);
        assert.equal(request.box.top, 760);
        assert.equal(typeof options?.signal, 'undefined');
        return result;
      },
    },
    store: {
      getArtifact(id) {
        assert.equal(id, result.artifact.id);
        return result.artifact;
      },
      async deleteArtifact(id) {
        deleted.push(id);
      },
    },
  }, {
    capabilityId: CAPABILITY_ID,
    input: 'input.pdf',
    requestPath: 'request.json',
    output: 'output.pdf',
  }, {}, undefined, {
    cancelled: () => {},
    uploadPdf: async (_application, input) => {
      assert.equal(input, 'input.pdf');
      return { id: '22222222-2222-4222-8222-222222222222', sha256: sourceSha256 };
    },
    readLocalInputBytes: async (path) => {
      assert.equal(path, 'request.json');
      return { bytes: Buffer.from(JSON.stringify(requestFor(sourceSha256))) };
    },
    copyExclusive: async (...args) => { copied.push(args); },
    emit: async (_stdout, value) => { emitted.push(value); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  });
  assert.deepEqual(copied, [['/tmp/artifact.pdf', 'output.pdf', undefined]]);
  assert.equal(emitted.length, 1);
  assert.equal('pdf' in emitted[0], false);
  assert.equal('sourceSha256' in emitted[0], false);
  assert.equal('filePath' in emitted[0].artifact, false);
  assert.equal('sourceSha256' in emitted[0].serviceReceipt, false);
  assert.equal('filePath' in emitted[0].serviceReceipt.artifact, false);
  assert.equal(deleted[0], result.artifact.id);
  assert.equal(emitted[0].artifact.output, 'output.pdf');
  assert.equal(emitted[0].serviceReceipt.artifact.output, 'output.pdf');
});

test('professional page-boxes CLI rejects invalid box requests', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  await assert.rejects(
    () => runProfessionalCapabilityCommand({
      professionalCapabilities: {
        async deliverPageOrganizationSourceBound() {
          assert.fail('delivery must not be called for an invalid request');
        },
      },
      store: { getArtifact() { assert.fail('artifact lookup must not occur'); } },
    }, {
      capabilityId: CAPABILITY_ID,
      input: 'input.pdf',
      requestPath: 'request.json',
      output: 'output.pdf',
    }, {}, undefined, {
      cancelled: () => {},
      uploadPdf: async () => ({ id: '11111111-1111-4111-8111-111111111111', sha256: sourceSha256 }),
      readLocalInputBytes: async () => ({
        bytes: Buffer.from(JSON.stringify({
          sourceSha256,
          page: PAGE,
          boxType: 'crop',
          box: { left: 10, bottom: 10, right: 10, top: 20 },
        })),
      }),
      copyExclusive: async () => { throw new Error('must not copy'); },
      emit: async () => { throw new Error('must not emit'); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    }),
    { code: 'CLI_INVALID_PROFESSIONAL_PAGE_BOXES_REQUEST' },
  );
});

test('professional page-boxes CLI rejects source digest mismatch for source-bound request', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  await assert.rejects(
    () => runProfessionalCapabilityCommand({
      professionalCapabilities: {
        async deliverPageOrganizationSourceBound() {
          assert.fail('delivery must not be called when source digest mismatches');
        },
      },
      store: { getArtifact() { assert.fail('artifact lookup must not occur'); } },
    }, {
      capabilityId: CAPABILITY_ID,
      input: 'input.pdf',
      requestPath: 'request.json',
      output: 'output.pdf',
    }, {}, undefined, {
      cancelled: () => {},
      uploadPdf: async () => ({ id: '11111111-1111-4111-8111-111111111111', sha256: sourceSha256 }),
      readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(requestFor('f'.repeat(64)))) }),
      copyExclusive: async () => { throw new Error('must not copy'); },
      emit: async () => { throw new Error('must not emit'); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    }),
    { code: 'SOURCE_VERSION_MISMATCH' },
  );
});

test('professional page-boxes CLI rejects forged retained artifact and cleans up', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  const forgedArtifact = makeArtifact({
    id: '11111111-1111-4111-8111-111111111111',
    documentId: 'other-document-id',
    sha256: createHash('sha256').update('OUTPUT').digest('hex'),
    filePath: '/tmp/artifact.pdf',
  });
  const deleted = [];
  await assert.rejects(
    () => runProfessionalCapabilityCommand({
      professionalCapabilities: {
        async deliverPageOrganizationSourceBound() {
          return Object.freeze({
            capabilityId: CAPABILITY_ID,
            outputSha256: createHash('sha256').update('OUTPUT').digest('hex'),
            artifact: forgedArtifact,
            pdf: Buffer.from('private'),
            page: PAGE,
            boxType: 'crop',
            box: requestFor(sourceSha256).box,
          });
        },
      },
      store: {
        getArtifact() { return forgedArtifact; },
        async deleteArtifact(id) { deleted.push(id); },
      },
    }, {
      capabilityId: CAPABILITY_ID,
      input: 'input.pdf',
      requestPath: 'request.json',
      output: 'output.pdf',
    }, {}, undefined, {
      cancelled: () => {},
      uploadPdf: async () => ({ id: '22222222-2222-4222-8222-222222222222', sha256: sourceSha256 }),
      readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(requestFor(sourceSha256))) }),
      copyExclusive: async () => { throw new Error('must not copy'); },
      emit: async () => { throw new Error('must not emit'); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    }),
    { code: 'PROFESSIONAL_PAGE_BOXES_RECEIPT_INVALID' },
  );
  assert.deepEqual(deleted, [forgedArtifact.id]);
});

test('professional page-boxes CLI propagates cancellation for copy and still deletes trusted artifact', async () => {
  const controller = new AbortController();
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  const outputSha256 = createHash('sha256').update('OUTPUT').digest('hex');
  const artifact = makeArtifact({
    id: '11111111-1111-4111-8111-111111111111',
    documentId: '22222222-2222-4222-8222-222222222222',
    sha256: outputSha256,
    filePath: '/tmp/artifact.pdf',
  });
  const deleted = [];
  await assert.rejects(
    () => runProfessionalCapabilityCommand({
      professionalCapabilities: {
        async deliverPageOrganizationSourceBound() {
          return Object.freeze({
            capabilityId: CAPABILITY_ID,
            outputSha256,
            artifact,
            pdf: Buffer.from('private'),
            page: PAGE,
            boxType: 'bleed',
            box: { left: 10, bottom: 10, right: 602, top: 782 },
          });
        },
      },
      store: {
        getArtifact: () => artifact,
        async deleteArtifact(id) { deleted.push(id); },
      },
    }, {
      capabilityId: CAPABILITY_ID,
      input: 'input.pdf',
      requestPath: 'request.json',
      output: 'output.pdf',
    }, {}, controller.signal, {
      cancelled(signal) {
        if (signal?.aborted) {
          throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
        }
      },
      uploadPdf: async () => ({ id: '22222222-2222-4222-8222-222222222222', sha256: sourceSha256 }),
      readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(requestFor(sourceSha256, {
        boxType: 'bleed',
        box: { left: 10, bottom: 10, right: 602, top: 782 },
      }))) }),
      copyExclusive: async () => {
        controller.abort();
      },
      emit: async () => { throw new Error('must not emit'); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    }),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(deleted, [artifact.id]);
});

test('professional page-boxes CLI aggregates copy and cleanup failures', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  const outputSha256 = createHash('sha256').update('OUTPUT').digest('hex');
  const artifact = makeArtifact({
    id: '11111111-1111-4111-8111-111111111111',
    documentId: '22222222-2222-4222-8222-222222222222',
    sha256: outputSha256,
    filePath: '/tmp/artifact.pdf',
  });
  let copyErr;
  let cleanupErr;
  const deleteAttempts = [];
  const error = await runProfessionalCapabilityCommand({
    professionalCapabilities: {
      async deliverPageOrganizationSourceBound() {
        return Object.freeze({
          capabilityId: CAPABILITY_ID,
          outputSha256,
          artifact,
          pdf: Buffer.from('private'),
          page: PAGE,
          boxType: 'crop',
          box: requestFor(sourceSha256).box,
        });
      },
    },
    store: {
      getArtifact() { return artifact; },
      async deleteArtifact(id) {
        deleteAttempts.push(id);
        cleanupErr = new Error('cleanup failed');
        throw cleanupErr;
      },
    },
  }, {
    capabilityId: CAPABILITY_ID,
    input: 'input.pdf',
    requestPath: 'request.json',
    output: 'output.pdf',
  }, {}, undefined, {
    cancelled: () => {},
    uploadPdf: async () => ({ id: '22222222-2222-4222-8222-222222222222', sha256: sourceSha256 }),
    readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(requestFor(sourceSha256))) }),
    copyExclusive: async () => {
      copyErr = new Error('copy failed');
      throw copyErr;
    },
    emit: async () => { throw new Error('must not emit'); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  }).then(
    () => null,
    (value) => value,
  );
  assert.equal(error instanceof AggregateError, true);
  assert.equal(error.errors.includes(copyErr), true);
  assert.equal(error.errors.includes(cleanupErr), true);
  assert.deepEqual(deleteAttempts, [artifact.id]);
});
