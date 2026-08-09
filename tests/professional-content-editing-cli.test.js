import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runProfessionalCapabilityCommand } from '../scripts/cli/commands/professional-capability.mjs';
import { PDF_TEXT_EDIT_PROFILE } from '../scripts/host/pdf-text-edit-contract.mjs';

const SOURCE_BOUND_TEXT_EDIT_CAPABILITIES = Object.freeze(['edit.text', 'edit.find-replace']);

function makeRequest(sourceSha256, overrides = {}) {
  return Object.freeze({
    profile: PDF_TEXT_EDIT_PROFILE,
    page: 1,
    find: 'hello world',
    replace: 'HELLO WORLD',
    sourceSha256,
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

function requestFor(capabilityId, sourceSha256) {
  return Object.freeze({
    capabilityId,
    outputSha256: createHash('sha256').update('OUTPUT').digest('hex'),
    artifact: makeArtifact({
      id: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      sha256: createHash('sha256').update('OUTPUT').digest('hex'),
      filePath: '/tmp/artifact.pdf',
    }),
    pdf: Buffer.from('private PDF bytes'),
    find: 'hello world',
    replace: 'HELLO WORLD',
    serviceReceipt: {
      artifact: {
        id: '11111111-1111-4111-8111-111111111111',
        documentId: '22222222-2222-4222-8222-222222222222',
        mediaType: 'application/pdf',
        size: 14,
        sha256: createHash('sha256').update('OUTPUT').digest('hex'),
        filePath: '/tmp/artifact.pdf',
      },
      sourceSha256,
      find: 'hello world',
      replace: 'HELLO WORLD',
    },
  });
}

for (const capabilityId of SOURCE_BOUND_TEXT_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI parses ${capabilityId} source-bound source/request/output contract`, () => {
    const parsed = parseCliArguments([
      'professional-capability', 'input.pdf', '--capability-id', capabilityId,
      '--request', 'request.json', '--output', 'output.pdf',
    ]);
    assert.equal(parsed.capabilityId, capabilityId);
    assert.equal(parsed.input, 'input.pdf');
    assert.equal(parsed.requestPath, 'request.json');
    assert.equal(parsed.output, 'output.pdf');
  });
}

for (const capabilityId of SOURCE_BOUND_TEXT_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI performs source-bound ${capabilityId} and emits a privacy-safe receipt`, async () => {
    const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
    const result = requestFor(capabilityId, sourceSha256);
    const emitted = [];
    const copied = [];
    const deleted = [];
    const application = {
      professionalCapabilities: {
        async deliverTextSourceBound(capability, documentId, request, options) {
          assert.equal(capability, capabilityId);
          assert.equal(documentId, '22222222-2222-4222-8222-222222222222');
          assert.equal(request.page, 1);
          assert.equal(request.find, 'hello world');
          assert.equal(request.replace, 'HELLO WORLD');
          assert.equal(request.sourceSha256, sourceSha256);
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
    };
    await runProfessionalCapabilityCommand(application, {
      capabilityId,
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
        return { bytes: Buffer.from(JSON.stringify(makeRequest(sourceSha256))) };
      },
      copyExclusive: async (...args) => { copied.push(args); },
      emit: async (_stdout, value) => { emitted.push(value); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    });
    assert.deepEqual(copied, [['/tmp/artifact.pdf', 'output.pdf', undefined]]);
    assert.equal(emitted.length, 1);
    assert.equal('pdf' in emitted[0], false);
    assert.equal('find' in emitted[0], false);
    assert.equal('replace' in emitted[0], false);
    assert.equal(deleted[0], result.artifact.id);
    assert.equal(emitted[0].artifact.output, 'output.pdf');
  });
}

for (const capabilityId of SOURCE_BOUND_TEXT_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI rejects ${capabilityId} request source digest mismatch`, async () => {
    const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
    await assert.rejects(
      () => runProfessionalCapabilityCommand({
        professionalCapabilities: {
          async deliverTextSourceBound() {
            assert.fail('delivery must not be called when source digest mismatches');
          },
        },
        store: { getArtifact() { assert.fail('artifact lookup must not occur'); } },
      }, {
        capabilityId,
        input: 'input.pdf',
        requestPath: 'request.json',
        output: 'output.pdf',
      }, {}, undefined, {
        cancelled: () => {},
        uploadPdf: async () => ({ id: '11111111-1111-4111-8111-111111111111', sha256: sourceSha256 }),
        readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(makeRequest('f'.repeat(64)))) }),
        copyExclusive: async () => { throw new Error('must not copy'); },
        emit: async () => { throw new Error('must not emit'); },
        fail(code, message) { throw Object.assign(new Error(message), { code }); },
      }),
      { code: 'SOURCE_VERSION_MISMATCH' },
    );
  });
}

for (const capabilityId of SOURCE_BOUND_TEXT_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI rejects forged retained artifact for ${capabilityId} and cleans up`, async () => {
    const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
    const outputSha256 = createHash('sha256').update('OUTPUT').digest('hex');
    const retainedArtifact = makeArtifact({
      id: '11111111-1111-4111-8111-111111111111',
      documentId: 'other-document-id',
      sha256: outputSha256,
      filePath: '/tmp/artifact.pdf',
    });
    const deleted = [];
    await assert.rejects(
      () => runProfessionalCapabilityCommand({
        professionalCapabilities: {
          async deliverTextSourceBound() {
            return Object.freeze({
              capabilityId,
              outputSha256,
              artifact: retainedArtifact,
              pdf: Buffer.from('private'),
            });
          },
        },
        store: {
          getArtifact() {
            return retainedArtifact;
          },
          async deleteArtifact(id) {
            deleted.push(id);
          },
        },
      }, {
        capabilityId,
        input: 'input.pdf',
        requestPath: 'request.json',
        output: 'output.pdf',
      }, {}, undefined, {
        cancelled: () => {},
        uploadPdf: async () => ({ id: '22222222-2222-4222-8222-222222222222', sha256: sourceSha256 }),
        readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(makeRequest(sourceSha256))) }),
        copyExclusive: async () => { throw new Error('must not copy'); },
        emit: async () => { throw new Error('must not emit'); },
        fail(code, message) { throw Object.assign(new Error(message), { code }); },
      }),
      { code: 'PROFESSIONAL_TEXT_EDIT_RECEIPT_INVALID' },
    );
    assert.deepEqual(deleted, [retainedArtifact.id]);
  });
}

for (const capabilityId of SOURCE_BOUND_TEXT_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI propagates cancellation for ${capabilityId} and still deletes trusted artifact`, async () => {
    const controller = new AbortController();
    const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
    const outputSha256 = createHash('sha256').update('OUTPUT').digest('hex');
    const deleted = [];
    const artifact = makeArtifact({
      id: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      sha256: outputSha256,
      filePath: '/tmp/artifact.pdf',
    });
    await assert.rejects(
      () => runProfessionalCapabilityCommand({
        professionalCapabilities: {
          async deliverTextSourceBound() {
            return Object.freeze({
              capabilityId,
              outputSha256,
              artifact,
              pdf: Buffer.from('private'),
            });
          },
        },
        store: {
          getArtifact: () => artifact,
          async deleteArtifact(id) {
            deleted.push(id);
          },
        },
      }, {
        capabilityId,
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
        readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(makeRequest(sourceSha256))) }),
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
}

for (const capabilityId of SOURCE_BOUND_TEXT_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI aggregates copy and cleanup failures for ${capabilityId}`, async () => {
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
        async deliverTextSourceBound() {
          return Object.freeze({
            capabilityId,
            outputSha256,
            artifact,
            pdf: Buffer.from('private'),
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
      capabilityId,
      input: 'input.pdf',
      requestPath: 'request.json',
      output: 'output.pdf',
    }, {}, undefined, {
      cancelled: () => {},
      uploadPdf: async () => ({ id: '22222222-2222-4222-8222-222222222222', sha256: sourceSha256 }),
      readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(makeRequest(sourceSha256))) }),
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
}
