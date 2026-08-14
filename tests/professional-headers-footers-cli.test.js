import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runProfessionalCapabilityCommand } from '../scripts/cli/commands/professional-capability.mjs';
import { parseCliArguments } from '../scripts/cli/parser.mjs';

const CAPABILITY_ID = 'edit.headers-footers';
const PROFILE = 'local-pdf-page-header-footer-v1';

function requestFor(sourceSha256, overrides = {}) {
  return Object.freeze({
    profile: PROFILE,
    sourceSha256,
    pages: Object.freeze([1, 3]),
    header: 'PRIVATE HEADER',
    footerPrefix: 'PRIVATE FOOTER',
    ...overrides,
  });
}

function artifactFor({ documentId, sha256, filePath = '/private/output.pdf' }) {
  return Object.freeze({
    id: '11111111-1111-4111-8111-111111111111',
    documentId,
    mediaType: 'application/pdf',
    size: 14,
    sha256,
    filePath,
  });
}

function resultFor(sourceSha256, overrides = {}) {
  const outputSha256 = createHash('sha256').update('OUTPUT').digest('hex');
  const artifact = artifactFor({
    documentId: '22222222-2222-4222-8222-222222222222',
    sha256: outputSha256,
  });
  return Object.freeze({
    profile: PROFILE,
    method: 'source-bound-pdf-page-header-footer',
    outputSha256,
    artifact,
    pdf: Buffer.from('private PDF bytes'),
    sourceSha256,
    header: 'PRIVATE HEADER',
    footerPrefix: 'PRIVATE FOOTER',
    privatePath: '/private/service',
    ...overrides,
  });
}

function runtimeFor(overrides = {}) {
  return {
    cancelled: () => {},
    uploadPdf: async () => ({ id: '22222222-2222-4222-8222-222222222222', sha256: 'a'.repeat(64) }),
    readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(requestFor('a'.repeat(64))) ) }),
    copyExclusive: async () => {},
    emit: async () => {},
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
    ...overrides,
  };
}

function command() {
  return {
    capabilityId: CAPABILITY_ID,
    input: 'input.pdf',
    requestPath: 'request.json',
    output: 'output.pdf',
  };
}

test('professional header/footer CLI parses the exact source-bound source/request/output contract', () => {
  const parsed = parseCliArguments([
    'professional-capability', 'input.pdf', '--capability-id', CAPABILITY_ID,
    '--request', 'request.json', '--output', 'output.pdf',
  ]);
  assert.deepEqual(parsed, {
    command: 'professional-capability', capabilityId: CAPABILITY_ID, input: 'input.pdf',
    requestPath: 'request.json', output: 'output.pdf',
  });
  assert.throws(() => parseCliArguments([
    'professional-capability', 'input.pdf', '--capability-id', CAPABILITY_ID, '--output', 'output.pdf',
  ]), { code: 'CLI_INVALID_OPTION' });
});

test('professional header/footer CLI binds the exact normalized request, copies exclusively, zeroes request bytes, and emits no private content', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const result = resultFor(sourceSha256);
  const copied = [];
  const emitted = [];
  const deleted = [];
  const selected = Buffer.from(JSON.stringify(requestFor(sourceSha256)));
  await runProfessionalCapabilityCommand({
    professionalCapabilities: {
      async deliverContentEditingSourceBound(capabilityId, documentId, request, options) {
        assert.equal(capabilityId, CAPABILITY_ID);
        assert.equal(documentId, '22222222-2222-4222-8222-222222222222');
        assert.deepEqual(request, requestFor(sourceSha256));
        assert.equal(typeof options.signal, 'undefined');
        return result;
      },
    },
    store: {
      getArtifact(id) { assert.equal(id, result.artifact.id); return result.artifact; },
      async deleteArtifact(id) { deleted.push(id); },
    },
  }, command(), {}, undefined, runtimeFor({
    readLocalInputBytes: async (path, options) => {
      assert.equal(path, 'request.json');
      assert.deepEqual(options, { minimumBytes: 2, maximumBytes: 128 * 1024, extension: '.json', signal: undefined });
      return { bytes: selected };
    },
    copyExclusive: async (...args) => { copied.push(args); },
    emit: async (_stdout, receipt) => { emitted.push(receipt); },
  }));
  assert.deepEqual(copied, [['/private/output.pdf', 'output.pdf', undefined]]);
  assert.deepEqual(deleted, [result.artifact.id]);
  assert.equal(selected.every((byte) => byte === 0), true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].artifact.output, 'output.pdf');
  assert.doesNotMatch(JSON.stringify(emitted[0]), /PRIVATE HEADER|PRIVATE FOOTER|sourceSha256|private\/|PDF bytes/u);
});

test('professional header/footer CLI rejects a source digest mismatch before delivery', async () => {
  await assert.rejects(
    () => runProfessionalCapabilityCommand({
      professionalCapabilities: { async deliverContentEditingSourceBound() { assert.fail('must not deliver'); } },
      store: { getArtifact() { assert.fail('must not read artifact'); } },
    }, command(), {}, undefined, runtimeFor({
      readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(requestFor('b'.repeat(64)))) }),
    })),
    { code: 'SOURCE_VERSION_MISMATCH' },
  );
});

test('professional header/footer CLI rejects a forged retained receipt without deleting its untrusted artifact id', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const result = resultFor(sourceSha256);
  const forged = artifactFor({ documentId: 'forged-document', sha256: result.outputSha256 });
  const deleted = [];
  await assert.rejects(
    () => runProfessionalCapabilityCommand({
      professionalCapabilities: { async deliverContentEditingSourceBound() { return { ...result, artifact: forged }; } },
      store: {
        getArtifact() { return forged; },
        async deleteArtifact(id) { deleted.push(id); },
      },
    }, command(), {}, undefined, runtimeFor()),
    { code: 'PROFESSIONAL_HEADER_FOOTER_RECEIPT_INVALID' },
  );
  assert.deepEqual(deleted, []);
});

test('professional header/footer CLI propagates cancellation after exclusive copy and still revokes the artifact', async () => {
  const controller = new AbortController();
  const result = resultFor('a'.repeat(64));
  const deleted = [];
  await assert.rejects(
    () => runProfessionalCapabilityCommand({
      professionalCapabilities: { async deliverContentEditingSourceBound() { return result; } },
      store: {
        getArtifact() { return result.artifact; },
        async deleteArtifact(id) { deleted.push(id); },
      },
    }, command(), {}, controller.signal, runtimeFor({
      cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); },
      copyExclusive: async () => { controller.abort(); },
    })),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(deleted, [result.artifact.id]);
});

test('professional header/footer CLI aggregates output-copy and artifact-cleanup failures', async () => {
  const result = resultFor('a'.repeat(64));
  const copyError = new Error('copy failed');
  const cleanupError = new Error('cleanup failed');
  const deleted = [];
  const error = await runProfessionalCapabilityCommand({
    professionalCapabilities: { async deliverContentEditingSourceBound() { return result; } },
    store: {
      getArtifact() { return result.artifact; },
      async deleteArtifact(id) { deleted.push(id); throw cleanupError; },
    },
  }, command(), {}, undefined, runtimeFor({
    copyExclusive: async () => { throw copyError; },
  })).then(() => null, (value) => value);
  assert.equal(error instanceof AggregateError, true);
  assert.equal(error.errors.includes(copyError), true);
  assert.equal(error.errors.includes(cleanupError), true);
  assert.deepEqual(deleted, [result.artifact.id]);
});
