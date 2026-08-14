import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMethodPermission, METHOD_PERMISSIONS } from '../src/core/permissions.js';
import { validateRpcRequest } from '../src/core/plugin-protocol.js';

const source = {};
const binding = {
  nonce: 'a'.repeat(64), pluginId: 'org.platen.example', version: '1.0.0',
  packageHash: 'b'.repeat(64), activationId: 'activation_1234567890',
};
const context = { binding, source, expectedSource: source };

function request(overrides = {}) {
  return {
    protocol: 1,
    nonce: binding.nonce,
    pluginId: 'org.platen.example',
    version: binding.version,
    packageHash: binding.packageHash,
    activationId: binding.activationId,
    type: 'request',
    id: 'request_1',
    sequence: 1,
    method: 'document.getMetadata',
    params: {},
    ...overrides,
  };
}

test('valid RPC request is bound to source, nonce, and plugin ID', () => {
  assert.equal(validateRpcRequest(request(), context).id, 'request_1');
  assert.throws(() => validateRpcRequest(request({ nonce: 'wrong' }), context), { code: 'REQUEST_INVALID' });
  assert.throws(() => validateRpcRequest(request(), { ...context, source: {} }), { code: 'REQUEST_INVALID' });
  assert.throws(() => validateRpcRequest(request({ pluginId: 'org.platen.other' }), context), { code: 'REQUEST_INVALID' });
});

test('RPC rejects unknown fields and oversized messages', () => {
  assert.throws(() => validateRpcRequest(request({ unexpected: true }), context), { code: 'REQUEST_INVALID' });
  assert.throws(() => validateRpcRequest(request({ params: { text: 'x'.repeat(300) } }), { ...context, maxBytes: 200 }), { code: 'REQUEST_TOO_LARGE' });
});

test('every host method has a permission and undeclared access is denied', () => {
  assert.ok(Object.keys(METHOD_PERMISSIONS).length > 0);
  for (const permissions of Object.values(METHOD_PERMISSIONS)) assert.ok(permissions.length > 0);
  assert.equal(assertMethodPermission('document.getMetadata', ['document.metadata']), true);
  assert.throws(() => assertMethodPermission('document.readRange', ['document.metadata']), { code: 'PERMISSION_DENIED' });
  assert.throws(() => assertMethodPermission('host.unknown', []), { code: 'REQUEST_INVALID' });
});
