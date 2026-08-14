import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runProfessionalCapabilityCommand } from '../scripts/cli/commands/professional-capability.mjs';

const SOURCE_BOUND_METADATA_EDIT_CAPABILITIES = Object.freeze(['document.metadata-edit']);
function makeMetadataRequest(sourceSha256, overrides = {}) {
  return Object.freeze({
    sourceSha256,
    metadata: Object.freeze({
      title: 'Document title',
      author: 'Document author',
      subject: 'Source subject',
      keywords: 'metadata, test',
      ...overrides,
    }),
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

function requestForMetadata(capabilityId, sourceSha256, options = {}) {
  const outputSha256 = createHash('sha256').update('OUTPUT').digest('hex');
  const metadata = Object.freeze(options.metadata ?? {
    title: 'Document title',
    author: 'Document author',
    subject: 'Source subject',
    keywords: 'metadata, test',
  });
  const artifact = makeArtifact({
    id: '11111111-1111-4111-8111-111111111111',
    documentId: '22222222-2222-4222-8222-222222222222',
    sha256: outputSha256,
    filePath: '/tmp/artifact.pdf',
  });
  return Object.freeze({
    capabilityId,
    outputSha256,
    artifact,
    pdf: Buffer.from('private PDF bytes'),
    metadata,
    serviceReceipt: {
      artifact,
      metadata,
      sourceSha256,
    },
  });
}

for (const capabilityId of SOURCE_BOUND_METADATA_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI parses ${capabilityId} source/request/output contract`, () => {
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

for (const capabilityId of SOURCE_BOUND_METADATA_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI performs source-bound ${capabilityId} and emits a privacy-safe metadata receipt`, async () => {
    const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
    const result = requestForMetadata(capabilityId, sourceSha256);
    const emitted = [];
    const copied = [];
    const deleted = [];
    const application = {
      professionalCapabilities: {
        async deliverContentEditingSourceBound(capability, documentId, request, options) {
          assert.equal(capability, capabilityId);
          assert.equal(documentId, '22222222-2222-4222-8222-222222222222');
          assert.equal(request.sourceSha256, sourceSha256);
          assert.equal(request.metadata.title, 'Document title');
          assert.equal(request.metadata.author, 'Document author');
          assert.equal(request.metadata.subject, 'Source subject');
          assert.equal(request.metadata.keywords, 'metadata, test');
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
        return { bytes: Buffer.from(JSON.stringify(makeMetadataRequest(sourceSha256))) };
      },
      copyExclusive: async (...args) => { copied.push(args); },
      emit: async (_stdout, value) => { emitted.push(value); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    });
    assert.deepEqual(copied, [['/tmp/artifact.pdf', 'output.pdf', undefined]]);
    assert.equal(emitted.length, 1);
    assert.equal('pdf' in emitted[0], false);
    assert.equal('metadata' in emitted[0], false);
    assert.equal('metadata' in emitted[0].serviceReceipt, false);
    assert.equal(deleted[0], result.artifact.id);
    assert.equal(emitted[0].artifact.output, 'output.pdf');
  });
}

for (const capabilityId of SOURCE_BOUND_METADATA_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI accepts nullable bounds for ${capabilityId} metadata`, async () => {
    const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
    const emitted = [];
    let called = false;
    const deleted = [];
    await runProfessionalCapabilityCommand({
      professionalCapabilities: {
        async deliverContentEditingSourceBound() {
          called = true;
          const request = arguments[2];
          assert.equal(request.metadata.subject, null);
          assert.equal(request.metadata.keywords, null);
          return requestForMetadata(capabilityId, sourceSha256, {
            metadata: request.metadata,
          });
        },
      },
      store: {
        getArtifact: () => makeArtifact({
          id: '11111111-1111-4111-8111-111111111111',
          documentId: '22222222-2222-4222-8222-222222222222',
          sha256: createHash('sha256').update('OUTPUT').digest('hex'),
          filePath: '/tmp/artifact.pdf',
        }),
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
      readLocalInputBytes: async () => ({
        bytes: Buffer.from(JSON.stringify(makeMetadataRequest(sourceSha256, {
          subject: null,
          keywords: null,
        }))),
      }),
      copyExclusive: async (...args) => { emitted.push(args); },
      emit: async (_stdout, value) => { emitted.push(value); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    });
    assert.equal(called, true);
    assert.equal(emitted.length, 2);
    assert.equal('metadata' in emitted[1], false);
    assert.deepEqual(deleted, ['11111111-1111-4111-8111-111111111111']);
  });
}

for (const capabilityId of SOURCE_BOUND_METADATA_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI rejects ${capabilityId} request source digest mismatch`, async () => {
    const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
    await assert.rejects(
      () => runProfessionalCapabilityCommand({
        professionalCapabilities: {
          async deliverContentEditingSourceBound() {
            assert.fail('delivery must not be called when source digest mismatches');
          },
        },
        store: {
          getArtifact() { assert.fail('artifact lookup must not occur'); },
        },
      }, {
        capabilityId,
        input: 'input.pdf',
        requestPath: 'request.json',
        output: 'output.pdf',
      }, {}, undefined, {
        cancelled: () => {},
        uploadPdf: async () => ({ id: '11111111-1111-4111-8111-111111111111', sha256: sourceSha256 }),
        readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(makeMetadataRequest('f'.repeat(64)))) }),
        copyExclusive: async () => { throw new Error('must not copy'); },
        emit: async () => { throw new Error('must not emit'); },
        fail(code, message) { throw Object.assign(new Error(message), { code }); },
      }),
      { code: 'SOURCE_VERSION_MISMATCH' },
    );
  });
}

for (const capabilityId of SOURCE_BOUND_METADATA_EDIT_CAPABILITIES) {
  test(`professional content-edit CLI rejects forged retained artifact for ${capabilityId} and cleans up`, async () => {
    const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
    const outputSha256 = createHash('sha256').update('OUTPUT').digest('hex');
    const forgedArtifact = makeArtifact({
      id: '11111111-1111-4111-8111-111111111111',
      documentId: 'other-document-id',
      sha256: outputSha256,
      filePath: '/tmp/artifact.pdf',
    });
    const deleted = [];
    const forgedResult = requestForMetadata(capabilityId, sourceSha256, {
      metadata: Object.freeze({
        title: 'Forged',
        author: 'Forged',
        subject: 'Forged',
        keywords: 'forged',
      }),
    });
    await assert.rejects(
      () => runProfessionalCapabilityCommand({
        professionalCapabilities: {
          async deliverContentEditingSourceBound(_capabilityId, _documentId, _request, _options) {
            return Object.freeze({
              capabilityId,
              outputSha256,
              artifact: forgedArtifact,
              pdf: Buffer.from('private'),
              metadata: forgedResult.metadata,
            });
          },
        },
        store: {
          getArtifact() {
            return forgedArtifact;
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
        readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(makeMetadataRequest(sourceSha256, { title: 'Input title' }))) }),
        copyExclusive: async () => { throw new Error('must not copy'); },
        emit: async () => { throw new Error('must not emit'); },
        fail(code, message) { throw Object.assign(new Error(message), { code }); },
      }),
      { code: 'PROFESSIONAL_METADATA_EDIT_RECEIPT_INVALID' },
    );
    assert.deepEqual(deleted, [forgedArtifact.id]);
  });
}

for (const capabilityId of SOURCE_BOUND_METADATA_EDIT_CAPABILITIES) {
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
          async deliverContentEditingSourceBound() {
            return Object.freeze({
              capabilityId,
              outputSha256,
              artifact,
              pdf: Buffer.from('private'),
              metadata: {
                title: 'Title',
                author: 'Author',
                subject: 'Subject',
                keywords: 'Keywords',
              },
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
        readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(makeMetadataRequest(sourceSha256))) }),
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

for (const capabilityId of SOURCE_BOUND_METADATA_EDIT_CAPABILITIES) {
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
        async deliverContentEditingSourceBound() {
          return Object.freeze({
            capabilityId,
            outputSha256,
            artifact,
            pdf: Buffer.from('private'),
            metadata: {
              title: 'Title',
              author: 'Author',
              subject: 'Subject',
              keywords: 'Keywords',
            },
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
      readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(makeMetadataRequest(sourceSha256))) }),
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
