import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseTextReflow } from '../scripts/cli/parser-text-reflow.mjs';
import { runTextReflowCommand } from '../scripts/cli/commands/text-reflow.mjs';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_SHA256 = createHash('sha256').update('INPUT').digest('hex');
const OUTPUT_SHA256 = createHash('sha256').update('OUTPUT').digest('hex');
const REQUEST = {
  page: 1,
  streamRef: { object: 4, generation: 0 },
  lineTokenIndices: [7, 10, 13],
  lineWidth: 20,
  originalTextSha256: 'f'.repeat(64),
  replacementText: 'Alpha beta gamma delta epsilon',
};

function operation() {
  return { type: 'pdf-text-reflow' };
}

function resultFor(overrides = {}) {
  const artifact = {
    id: '22222222-2222-4222-8222-222222222222',
    documentId: DOCUMENT_ID,
    displayName: 'text-reflow.pdf',
    mediaType: 'application/pdf',
    size: 128,
    sha256: OUTPUT_SHA256,
    operation: operation(),
    createdAt: '2026-08-03T00:00:00.000Z',
  };
  return {
    kind: 'pdf-text-reflow',
    artifact: { ...artifact, ...overrides.artifact },
    proof: {
      profile: 'local-pdf-text-reflow-v1', outputSha256: OUTPUT_SHA256,
      sourcePrefixPreserved: true, page: 1, streamReference: '4 0 R', lineCount: 3,
      lineWidth: 20, fixedSlotReflow: true, textPositionsPreserved: true,
      typographyPreserved: true, streamByteLengthPreserved: true, revisionCount: 2,
      changedObjectCount: 1,
    },
    limitations: ['fixed-slot subset'],
  };
}

function runtimeFor({ bytes = REQUEST, copied = [], emitted = [], deleted = [], copy = null } = {}) {
  return {
    cancelled: () => {},
    canonicalOutputTarget: async () => {},
    readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(bytes)) }),
    copyExclusive: copy ?? (async (...args) => { copied.push(args); }),
    emit: async (_stdout, value) => { emitted.push(value); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
    copied,
    emitted,
    deleted,
  };
}

function applicationFor(result, runtime) {
  return {
    textReflow: {
      async reflow(documentId, request, options) {
        assert.equal(documentId, DOCUMENT_ID);
        assert.equal(request.profile, 'local-pdf-text-reflow-v1');
        assert.equal(request.sourceSha256, SOURCE_SHA256);
        assert.equal(options.signal, undefined);
        return result;
      },
    },
    store: {
      getArtifact(id) {
        assert.equal(id, result.artifact.id);
        return { ...result.artifact, filePath: '/private/tmp/text-reflow.pdf' };
      },
      async deleteArtifact(id) { runtime.deleted.push(id); },
    },
  };
}

test('text-reflow parser enforces INPUT/request/output contract', () => {
  const parsed = parseTextReflow('text-reflow', ['input.pdf'], new Map([['request', 'request.json']]), 'output.pdf');
  assert.deepEqual(parsed, { command: 'text-reflow', input: 'input.pdf', requestPath: 'request.json', output: 'output.pdf' });
  assert.throws(() => parseTextReflow('text-reflow', [], new Map(), 'output.pdf'), { code: 'CLI_INVALID_ARGUMENTS' });
});

test('text-reflow CLI injects profile/source digest, copies, emits privacy-safe receipt, and cleans up', async () => {
  const copied = []; const emitted = []; const deleted = []; const runtime = runtimeFor({ copied, emitted, deleted });
  const result = resultFor();
  await runTextReflowCommand(applicationFor(result, runtime), {
    input: 'input.pdf', requestPath: 'request.json', output: '/tmp/result.pdf',
  }, { id: DOCUMENT_ID, sha256: SOURCE_SHA256 }, {}, undefined, runtime);
  assert.deepEqual(copied, [['/private/tmp/text-reflow.pdf', '/tmp/result.pdf', undefined]]);
  assert.deepEqual(deleted, [result.artifact.id]);
  assert.equal(emitted.length, 1);
  const receipt = emitted[0];
  assert.equal(receipt.artifact.output, 'result.pdf');
  assert.equal('filePath' in receipt.artifact, false);
  assert.equal('sourceSha256' in receipt, false);
  assert.equal('sourceSha256' in receipt.proof, false);
  assert.equal('replacementText' in receipt.proof, false);
  assert.equal('operation' in receipt.artifact, false);
});

test('text-reflow CLI rejects malformed request files before delivery', async () => {
  const runtime = runtimeFor({ bytes: { ...REQUEST, extra: true } });
  await assert.rejects(
    runTextReflowCommand({ textReflow: { reflow: async () => assert.fail('must not deliver') }, store: {} }, {
      input: 'input.pdf', requestPath: 'request.json', output: 'output.pdf',
    }, { id: DOCUMENT_ID, sha256: SOURCE_SHA256 }, {}, undefined, runtime),
    { code: 'CLI_INVALID_TEXT_REFLOW_REQUEST' },
  );
});

test('text-reflow CLI does not delete an untrusted forged artifact', async () => {
  const deleted = []; const runtime = runtimeFor({ deleted });
  const result = resultFor({ artifact: { documentId: '33333333-3333-4333-8333-333333333333' } });
  await assert.rejects(
    runTextReflowCommand(applicationFor(result, runtime), {
      input: 'input.pdf', requestPath: 'request.json', output: 'output.pdf',
    }, { id: DOCUMENT_ID, sha256: SOURCE_SHA256 }, {}, undefined, runtime),
    { code: 'CLI_TEXT_REFLOW_RECEIPT_INVALID' },
  );
  assert.deepEqual(deleted, []);
});

test('text-reflow CLI revokes the trusted artifact when copy is cancelled', async () => {
  const deleted = []; const runtime = runtimeFor({ deleted, copy: async () => { throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); } });
  const result = resultFor();
  await assert.rejects(
    runTextReflowCommand(applicationFor(result, runtime), {
      input: 'input.pdf', requestPath: 'request.json', output: 'output.pdf',
    }, { id: DOCUMENT_ID, sha256: SOURCE_SHA256 }, {}, undefined, runtime),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(deleted, [result.artifact.id]);
});
