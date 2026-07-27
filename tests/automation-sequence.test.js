import test from 'node:test';
import {
  assert, AutomationOperationRegistry, Readable, inspection, digest, fixture, join,
  transientOcrStore, transientOutputIntentExecution, parseCliArguments,
} from './support/automation-execution-fixture.js';
import { automationSequenceRequest, AUTOMATION_SEQUENCE_TYPE, AUTOMATION_SEQUENCE_IDS, automationSequenceDescriptor } from '../scripts/host/automation/automation-sequence-contract.mjs';

const source = Object.freeze({ id: 'source_1', sha256: 'a'.repeat(64), size: 10 });

test('built-in sequences expose exact immutable two-step descriptors', () => {
  assert.deepEqual(AUTOMATION_SEQUENCE_IDS, ['inspect-then-ocr-english-v1', 'inspect-then-output-intent-cmyk-v1']);
  for (const id of AUTOMATION_SEQUENCE_IDS) {
    const descriptor = automationSequenceDescriptor(id);
    assert.equal(descriptor.schemaVersion, 1); assert.equal(descriptor.sequenceVersion, 1);
    assert.deepEqual(descriptor.steps, ['inspect-local-v1', descriptor.terminalPreset]);
    assert(Object.isFrozen(descriptor)); assert(Object.isFrozen(descriptor.steps));
  }
});

test('sequence payload validation rejects unknown, swapped, nested, and accessor surfaces', () => {
  const valid = { sourceId: source.id, sha256: source.sha256, sequenceId: AUTOMATION_SEQUENCE_IDS[0], sequenceVersion: 1 };
  assert.deepEqual(automationSequenceRequest(valid), valid);
  for (const bad of [{ ...valid, sequenceVersion: 2 }, { ...valid, sequenceId: 'unknown' }, { ...valid, extra: true }, { ...valid, sourceId: '../escape' }]) assert.throws(() => automationSequenceRequest(bad), { code: 'INVALID_AUTOMATION_OPERATION' });
  const accessor = {}; Object.defineProperty(accessor, 'sourceId', { enumerable: true, get: () => source.id }); Object.assign(accessor, { sha256: source.sha256, sequenceId: valid.sequenceId, sequenceVersion: 1 });
  assert.throws(() => automationSequenceRequest(accessor), { code: 'INVALID_AUTOMATION_OPERATION' });
  assert.throws(() => automationSequenceRequest(new Proxy(valid, {})), { code: 'INVALID_AUTOMATION_OPERATION' });
  assert.throws(() => automationSequenceRequest({ ...valid, [Symbol('forged')]: true }), { code: 'INVALID_AUTOMATION_OPERATION' });
});

test('registry emits one exact sequence queue request', () => {
  const request = new AutomationOperationRegistry().enqueueSequenceRequest(source, AUTOMATION_SEQUENCE_IDS[0]);
  assert.equal(request.type, AUTOMATION_SEQUENCE_TYPE); assert.deepEqual(request.payload, { sourceId: source.id, sha256: source.sha256, sequenceId: AUTOMATION_SEQUENCE_IDS[0], sequenceVersion: 1 });
  assert(Object.isFrozen(request)); assert(Object.isFrozen(request.payload));
});

test('sequence CLI accepts one allowlisted sequence and rejects collisions', () => {
  assert.deepEqual(parseCliArguments([
    'automation-submit-sequence', 'input.pdf', '--sequence', AUTOMATION_SEQUENCE_IDS[0],
    '--automation-root', 'private', '--idempotency-key', 'sequence-request',
  ]), {
    command: 'automation-submit-sequence', input: 'input.pdf',
    sequence: AUTOMATION_SEQUENCE_IDS[0], automationRoot: 'private',
    idempotencyKey: 'sequence-request', output: null,
  });
  for (const args of [
    ['automation-submit-sequence', 'input.pdf', '--automation-root', 'private'],
    ['automation-submit-sequence', 'input.pdf', '--sequence', 'unknown', '--automation-root', 'private'],
    ['automation-submit-sequence', 'input.pdf', '--sequence', AUTOMATION_SEQUENCE_IDS[0], '--operation', 'ocr', '--automation-root', 'private'],
  ]) assert.throws(() => parseCliArguments(args), { code: 'CLI_INVALID_OPTION' });
});

async function runtimeDependencies(t, kind) {
  const { root, bytes } = await fixture(t);
  const runtimeSource = Object.freeze({
    id: 'source_1', sha256: digest(bytes), size: bytes.length,
  });
  const artifactBytes = Buffer.from(`%PDF-1.7\n${kind}\n`);
  const artifactPath = join(root, `${kind}.pdf`);
  const execution = kind === 'ocr'
    ? transientOcrStore(runtimeSource, artifactPath, artifactBytes)
    : transientOutputIntentExecution(runtimeSource, artifactPath, artifactBytes);
  const order = [];
  const output = Object.freeze({
    id: 'output_1', sha256: execution.artifact.sha256,
    size: execution.artifact.size, sourceId: runtimeSource.id,
    sourceSha256: runtimeSource.sha256,
  });
  const sources = {
    async openVerified(id, sha256) {
      assert.equal(id, runtimeSource.id); assert.equal(sha256, runtimeSource.sha256);
      return { ...runtimeSource, stream: Readable.from([bytes]) };
    },
    async stagePromotedArtifact({ artifactId }) {
      assert.equal(artifactId, execution.artifact.id); order.push('stage'); return output;
    },
    async discardCreatedOutput() { throw new Error('unexpected output rollback'); },
  };
  const service = {
    async inspect() { order.push('inspect'); return inspection; },
    ...(kind === 'ocr' ? {
      async ocrDocument(...args) { order.push('ocr'); return execution.service.ocrDocument(...args); },
    } : {}),
  };
  const outputIntentService = kind === 'intent' ? {
    async assign(...args) { order.push('intent'); return execution.outputIntentService.assign(...args); },
  } : null;
  return { runtimeSource, order, output, sources, store: execution.store, service, outputIntentService };
}

for (const [kind, sequenceId, terminalOperation] of [
  ['ocr', AUTOMATION_SEQUENCE_IDS[0], 'automation_ocr_v1'],
  ['intent', AUTOMATION_SEQUENCE_IDS[1], 'automation_output_intent_v1'],
]) {
  test(`sequence runtime executes inspect then ${kind} with one final output`, async (t) => {
    const context = await runtimeDependencies(t, kind);
    const registry = new AutomationOperationRegistry();
    const result = await registry.execute(AUTOMATION_SEQUENCE_TYPE, {
      sourceId: context.runtimeSource.id,
      sha256: context.runtimeSource.sha256,
      sequenceId,
      sequenceVersion: 1,
    }, { ...context, signal: new AbortController().signal });
    assert.deepEqual(context.order, ['inspect', kind, 'stage']);
    assert.equal(result.pendingOutput, context.output);
    assert.deepEqual(result.receipt.durableOutput, {
      id: context.output.id, size: context.output.size, sha256: context.output.sha256,
    });
    assert.deepEqual(result.receipt.steps.map(({ position, preset, operation, status }) => ({
      position, preset, operation, status,
    })), [
      { position: 1, preset: 'inspect-local-v1', operation: 'automation_inspect_v1', status: 'completed' },
      { position: 2, preset: automationSequenceDescriptor(sequenceId).terminalPreset, operation: terminalOperation, status: 'completed' },
    ]);
    assert.equal(result.receipt.steps[0].receipt.operation, 'automation_inspect_v1');
    assert.equal(result.receipt.steps[1].receipt.operation, terminalOperation);
    assert(Object.isFrozen(result.receipt)); assert(Object.isFrozen(result.receipt.steps));
  });
}

test('sequence validates both steps before source access', async () => {
  let opened = false; let inspected = false;
  await assert.rejects(new AutomationOperationRegistry().execute(AUTOMATION_SEQUENCE_TYPE, {
    sourceId: source.id, sha256: source.sha256,
    sequenceId: AUTOMATION_SEQUENCE_IDS[1], sequenceVersion: 1,
  }, {
    sources: { async openVerified() { opened = true; } },
    store: { async createDocument() {}, async deleteDocument() {}, getArtifact() {} },
    service: { async inspect() { inspected = true; } },
  }), TypeError);
  assert.equal(opened, false); assert.equal(inspected, false);
});

test('sequence cancellation after terminal staging rolls back the sole output', async (t) => {
  const context = await runtimeDependencies(t, 'ocr');
  const controller = new AbortController();
  let discarded = null;
  const stage = context.sources.stagePromotedArtifact;
  context.sources.stagePromotedArtifact = async (...args) => {
    const output = await stage(...args);
    controller.abort();
    return output;
  };
  context.sources.discardCreatedOutput = async (output) => { discarded = output; };
  await assert.rejects(new AutomationOperationRegistry().execute(AUTOMATION_SEQUENCE_TYPE, {
    sourceId: context.runtimeSource.id,
    sha256: context.runtimeSource.sha256,
    sequenceId: AUTOMATION_SEQUENCE_IDS[0],
    sequenceVersion: 1,
  }, { ...context, signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.equal(discarded, context.output);
  assert.deepEqual(context.order, ['inspect', 'ocr', 'stage']);
});
