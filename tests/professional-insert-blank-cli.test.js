import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runProfessionalCapabilityCommand } from '../scripts/cli/commands/professional-capability.mjs';

const CAPABILITY_ID = 'pages.insert-blank';
const AFTER_PAGE = 2;

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

function requestFor(sourceSha256, afterPage = AFTER_PAGE) {
  return Object.freeze({ sourceSha256, afterPage });
}

function resultFor(sourceSha256, overrides = {}) {
  const outputSha256 = createHash('sha256').update('OUTPUT').digest('hex');
  const blankSourceSha256 = createHash('sha256').update('GENERATED-BLANK').digest('hex');
  const artifact = makeArtifact({
    id: '11111111-1111-4111-8111-111111111111',
    documentId: '22222222-2222-4222-8222-222222222222',
    sha256: outputSha256,
    filePath: '/private/artifact.pdf',
  });
  return Object.freeze({
    capabilityId: CAPABILITY_ID,
    method: 'source-bound-poppler-insert-blank',
    outputSha256,
    sourceSha256,
    blankSourceSha256,
    artifact,
    pdf: Buffer.from('private PDF bytes'),
    afterPage: AFTER_PAGE,
    operation: {
      type: 'insert-blank-page',
      inputs: [
        { documentId: artifact.documentId, sha256: sourceSha256, role: 'primary' },
        { documentId: '33333333-3333-4333-8333-333333333333', sha256: blankSourceSha256, role: 'source-1' },
      ],
      parameters: { afterPage: AFTER_PAGE },
    },
    serviceReceipt: {
      sourceSha256,
      blankSourceSha256,
      filePath: '/private/generated-blank.pdf',
      generatedBlank: { documentId: '33333333-3333-4333-8333-333333333333', sha256: blankSourceSha256 },
    },
    ...overrides,
  });
}

function command() {
  return {
    capabilityId: CAPABILITY_ID,
    input: 'INPUT.pdf',
    requestPath: 'request.json',
    output: 'OUTPUT.pdf',
  };
}

function runtimeFor(sourceSha256, requestValue, hooks = {}) {
  return {
    cancelled: hooks.cancelled ?? (() => {}),
    uploadPdf: hooks.uploadPdf ?? (async () => ({ id: '22222222-2222-4222-8222-222222222222', sha256: sourceSha256 })),
    readLocalInputBytes: hooks.readLocalInputBytes ?? (async () => ({ bytes: Buffer.from(JSON.stringify(requestValue)) })),
    copyExclusive: hooks.copyExclusive ?? (async (...args) => { hooks.copied?.push(args); }),
    emit: hooks.emit ?? (async (_stdout, value) => { hooks.emitted?.push(value); }),
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
}

function applicationFor(result, hooks = {}) {
  return {
    professionalCapabilities: {
      async deliverPageOrganizationSourceBound(capabilityId, documentId, request, options) {
        hooks.delivered?.push({ capabilityId, documentId, request, options });
        return result;
      },
    },
    store: {
      getArtifact(id) {
        hooks.lookups?.push(id);
        return hooks.retained ?? result.artifact;
      },
      async deleteArtifact(id) {
        hooks.deleted?.push(id);
      },
    },
  };
}

test('professional pages.insert-blank CLI parses exact INPUT.pdf/request/output contract', () => {
  const parsed = parseCliArguments([
    'professional-capability', 'INPUT.pdf', '--capability-id', CAPABILITY_ID,
    '--request', 'request.json', '--output', 'OUTPUT.pdf',
  ]);
  assert.equal(parsed.capabilityId, CAPABILITY_ID);
  assert.equal(parsed.input, 'INPUT.pdf');
  assert.equal(parsed.requestPath, 'request.json');
  assert.equal(parsed.output, 'OUTPUT.pdf');
});

test('professional pages.insert-blank CLI calls source-bound delivery, no-clobber copies, and emits a privacy-safe receipt', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  const result = resultFor(sourceSha256);
  const copied = [];
  const emitted = [];
  const deleted = [];
  const delivered = [];
  const application = applicationFor(result, { copied, emitted, deleted, delivered });
  await runProfessionalCapabilityCommand(application, command(), {}, undefined, runtimeFor(sourceSha256, requestFor(sourceSha256), { copied, emitted }));

  assert.deepEqual(delivered, [{
    capabilityId: CAPABILITY_ID,
    documentId: '22222222-2222-4222-8222-222222222222',
    request: { sourceSha256, afterPage: AFTER_PAGE },
    options: {},
  }]);
  assert.deepEqual(copied, [['/private/artifact.pdf', 'OUTPUT.pdf', undefined]]);
  assert.equal(emitted.length, 1);
  assert.equal('pdf' in emitted[0], false);
  assert.equal('sourceSha256' in emitted[0], false);
  assert.equal('blankSourceSha256' in emitted[0], false);
  assert.equal('operation' in emitted[0], false);
  assert.equal('serviceReceipt' in emitted[0], false);
  assert.equal('filePath' in emitted[0].artifact, false);
  assert.equal(JSON.stringify(emitted[0]).includes(sourceSha256), false);
  assert.equal(JSON.stringify(emitted[0]).includes('GENERATED-BLANK'), false);
  assert.equal(JSON.stringify(emitted[0]).includes('/private/'), false);
  assert.equal(emitted[0].artifact.output, 'OUTPUT.pdf');
  assert.equal(emitted[0].afterPage, AFTER_PAGE);
});

test('professional pages.insert-blank CLI rejects accessor, symbol, prototype, and extra request fields', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  const valid = requestFor(sourceSha256);
  const accessor = { sourceSha256, afterPage: AFTER_PAGE };
  Object.defineProperty(accessor, 'afterPage', { enumerable: true, get() { throw new Error('getter must not execute'); } });
  const symbol = { ...valid, [Symbol('extra')]: true };
  const inherited = Object.assign(Object.create({ inherited: true }), valid);
  const extra = { ...valid, unexpected: true };
  for (const invalidRequest of [accessor, symbol, inherited, extra]) {
    const originalParse = JSON.parse;
    JSON.parse = () => invalidRequest;
    try {
      await assert.rejects(
        () => runProfessionalCapabilityCommand(
          applicationFor(resultFor(sourceSha256)),
          command(),
          {},
          undefined,
          runtimeFor(sourceSha256, valid),
        ),
        { code: 'CLI_INVALID_PROFESSIONAL_PAGE_ORGANIZATION_REQUEST' },
      );
    } finally {
      JSON.parse = originalParse;
    }
  }
});

test('professional pages.insert-blank CLI rejects stale source digests and malformed afterPage values', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  await assert.rejects(
    () => runProfessionalCapabilityCommand(
      applicationFor(resultFor(sourceSha256)),
      command(),
      {},
      undefined,
      runtimeFor(sourceSha256, requestFor('f'.repeat(64))),
    ),
    { code: 'SOURCE_VERSION_MISMATCH' },
  );
  for (const afterPage of [0, -1, 1.5, Infinity, '2', null]) {
    await assert.rejects(
      () => runProfessionalCapabilityCommand(
        applicationFor(resultFor(sourceSha256)),
        command(),
        {},
        undefined,
        runtimeFor(sourceSha256, requestFor(sourceSha256, afterPage)),
      ),
      { code: 'CLI_INVALID_PROFESSIONAL_PAGE_ORGANIZATION_REQUEST' },
    );
  }
});

test('professional pages.insert-blank CLI rejects a forged retained receipt and revokes it', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  const result = resultFor(sourceSha256, {
    artifact: makeArtifact({
      id: '11111111-1111-4111-8111-111111111111',
      documentId: 'other-document-id',
      sha256: createHash('sha256').update('OUTPUT').digest('hex'),
      filePath: '/private/forged.pdf',
    }),
  });
  const deleted = [];
  await assert.rejects(
    () => runProfessionalCapabilityCommand(
      applicationFor(result, { deleted }),
      command(),
      {},
      undefined,
      runtimeFor(sourceSha256, requestFor(sourceSha256)),
    ),
    { code: 'PROFESSIONAL_PAGE_ORGANIZATION_RECEIPT_INVALID' },
  );
  assert.deepEqual(deleted, [result.artifact.id]);
});

test('professional pages.insert-blank CLI revokes retained output after copy failure and cancellation', async () => {
  const sourceSha256 = createHash('sha256').update('INPUT').digest('hex');
  const result = resultFor(sourceSha256);
  const deletedOnFailure = [];
  const copyError = new Error('copy failed');
  await assert.rejects(
    () => runProfessionalCapabilityCommand(
      applicationFor(result, { deleted: deletedOnFailure }),
      command(),
      {},
      undefined,
      runtimeFor(sourceSha256, requestFor(sourceSha256), { copyExclusive: async () => { throw copyError; } }),
    ),
    copyError,
  );
  assert.deepEqual(deletedOnFailure, [result.artifact.id]);

  const controller = new AbortController();
  const deletedOnCancel = [];
  await assert.rejects(
    () => runProfessionalCapabilityCommand(
      applicationFor(result, { deleted: deletedOnCancel }),
      command(),
      {},
      controller.signal,
      runtimeFor(sourceSha256, requestFor(sourceSha256), {
        cancelled(signal) {
          if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
        },
        copyExclusive: async () => { controller.abort(); },
      }),
    ),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(deletedOnCancel, [result.artifact.id]);
});
