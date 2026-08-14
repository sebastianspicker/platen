import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createPluginWorkerFailure, createPluginWorkerInvocation,
  decodePluginWorkerControl, encodePluginWorkerControl,
  validatePluginWorkerControlMessage,
} from '../scripts/host/plugin-worker-control.mjs';

const binding = Object.freeze({
  pluginId: 'org.platen.example', version: '1.0.0', packageHash: 'a'.repeat(64),
  activationId: 'activation_1234567890', operationId: 'operation_1234567890', nonce: 'b'.repeat(64),
});
const common = Object.freeze({ protocol: 1, ...binding });
const invoke = (overrides = {}) => ({
  ...common, type: 'invoke', capability: 'document.example', documentHandle: `pdfh_${'c'.repeat(64)}`,
  input: { pages: [1], options: { quality: 'review' } }, ...overrides,
});

test('one-shot worker control canonically round-trips the four exact message forms', () => {
  const messages = [
    invoke(),
    { ...common, type: 'completion', result: { accepted: true } },
    createPluginWorkerFailure(binding),
    { ...common, type: 'cancellation' },
  ];
  for (const message of messages) {
    const encoded = encodePluginWorkerControl(message, { binding });
    assert.deepEqual(decodePluginWorkerControl(encoded, { binding }), message);
  }
});

test('worker control rejects binding mismatch, extras, forbidden authorities, and unsanitized failures', () => {
  assert.throws(() => validatePluginWorkerControlMessage(invoke({ operationId: 'operation_attacker_12' }), binding), { code: 'PLUGIN_WORKER_CONTROL_BINDING_MISMATCH' });
  assert.throws(() => validatePluginWorkerControlMessage(invoke({ executable: 'plugin.mjs' }), binding), { code: 'PLUGIN_WORKER_CONTROL_INVALID' });
  assert.throws(() => validatePluginWorkerControlMessage(invoke({ capability: 'invalid' }), binding), { code: 'PLUGIN_WORKER_CONTROL_INVALID' });
  assert.throws(() => validatePluginWorkerControlMessage(invoke({ input: { documentId: 'secret' } }), binding), { code: 'PLUGIN_WORKER_CONTROL_INVALID' });
  assert.throws(() => validatePluginWorkerControlMessage({ ...common, type: 'failure', failure: { code: 'EIO', message: '/tmp/private.pdf' } }, binding), { code: 'PLUGIN_WORKER_CONTROL_INVALID' });
});

test('invocation helper binds only a capability declared by the signed package', () => {
  const message = createPluginWorkerInvocation({
    binding,
    declaredCapabilities: ['document.example'],
    capability: 'document.example',
    documentHandle: `pdfh_${'c'.repeat(64)}`,
    input: { pages: [1] },
  });
  assert.equal(message.capability, 'document.example');
  assert.equal(Object.isFrozen(message.input), true);
  assert.throws(() => createPluginWorkerInvocation({
    binding,
    declaredCapabilities: ['document.example'],
    capability: 'document.attacker',
    documentHandle: `pdfh_${'c'.repeat(64)}`,
    input: {},
  }), { code: 'PLUGIN_WORKER_CAPABILITY_UNDECLARED', status: 403 });
});

test('worker control fails closed on malformed, non-canonical, oversized, and over-nested envelopes', () => {
  const nonCanonical = Buffer.concat([encodePluginWorkerControl(invoke(), { binding }), Buffer.from(' ')]);
  assert.throws(() => decodePluginWorkerControl(nonCanonical, { binding }), { code: 'PLUGIN_WORKER_CONTROL_NON_CANONICAL' });
  assert.throws(() => decodePluginWorkerControl(Buffer.from([0xc3, 0x28]), { binding }), { code: 'PLUGIN_WORKER_CONTROL_INVALID_UTF8' });
  assert.throws(() => encodePluginWorkerControl(invoke({ input: 'x'.repeat(8 * 1024 + 1) }), { binding }), { code: 'PLUGIN_WORKER_CONTROL_TOO_LARGE' });
  assert.throws(() => encodePluginWorkerControl(invoke({ input: 'é'.repeat(4_097) }), { binding }), { code: 'PLUGIN_WORKER_CONTROL_TOO_LARGE' });
  assert.throws(() => validatePluginWorkerControlMessage(invoke({ input: { items: Array(9).fill('x'.repeat(8 * 1024)) } }), binding), { code: 'PLUGIN_WORKER_CONTROL_ENVELOPE_TOO_LARGE' });
  assert.throws(() => validatePluginWorkerControlMessage(invoke({ input: { a: { b: { c: { d: { e: { f: { g: { h: { i: true } } } } } } } } } }), binding), { code: 'PLUGIN_WORKER_CONTROL_TOO_DEEP' });
  assert.throws(() => encodePluginWorkerControl(invoke(), {}), { code: 'PLUGIN_WORKER_CONTROL_INVALID' });
});

test('validated worker-control data is deeply frozen from caller mutation', () => {
  const message = invoke();
  const validated = validatePluginWorkerControlMessage(message, binding);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.input), true);
  assert.equal(Object.isFrozen(validated.input.options), true);
  assert.throws(() => { validated.input.options.quality = 'unsafe'; }, TypeError);
  assert.equal(message.input.options.quality, 'review');
});

test('worker control schema is strict about every message variant and exposes no executable authority', () => {
  const schema = JSON.parse(readFileSync(new URL('../contracts/plugin-worker-control.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.type.enum, ['invoke', 'completion', 'failure', 'cancellation']);
  for (const forbidden of ['path', 'sourceId', 'documentId', 'environment', 'executable']) assert.equal(Object.hasOwn(schema.properties, forbidden), false);
  assert.equal(schema.oneOf.length, 4);
});
