import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginOperationSession } from '../scripts/host/plugin-operation-session.mjs';
import { decodePluginRpcFrame, encodePluginRpcFrame } from '../scripts/host/plugin-rpc-broker.mjs';

const pluginId = 'org.platen.example';
const packageHash = 'a'.repeat(64);
const opaqueHandle = `pdfh_${'c'.repeat(64)}`;

function launchDescriptor(overrides = {}) {
  return Object.freeze({
    id: pluginId,
    version: '1.0.0',
    digest: packageHash,
    packageHash,
    manifest: Object.freeze({
      manifestVersion: 3, id: pluginId, version: '1.0.0', entry: 'index.js',
      capabilities: ['document.example'], dependencies: [],
      runtime: Object.freeze({ kind: 'javascriptcore-classic-script', apiVersion: 1 }),
    }),
    publisher: Object.freeze({ publisherId: 'org.platen', keyId: 'test' }),
    packageRoot: '/private/session/packages/signed',
    entryPath: '/private/session/packages/signed/index.js',
    inventory: Object.freeze([{
      path: 'index.js', mediaType: 'text/javascript', size: 16, sha256: 'b'.repeat(64),
    }]),
    dependencies: Object.freeze([]),
    executableRuntime: Object.freeze({
      kind: 'javascriptcore-classic-script', apiVersion: 1, entry: 'index.js', sha256: 'b'.repeat(64),
    }),
    ...overrides,
  });
}

function fixture({ descriptor = launchDescriptor(), failHandle = false } = {}) {
  const calls = { grantIssues: [], handleIssues: [], grantRevokes: [], handleRevokes: [], audit: [] };
  const packages = { async getLaunchDescriptor() { return descriptor; } };
  const grants = {
    async issue(request) { calls.grantIssues.push(request); return { grantId: 'pg_test' }; },
    revokeActivation(id, reason) { calls.grantRevokes.push([id, reason]); return 1; },
  };
  const handles = {
    issue(request) {
      calls.handleIssues.push(request);
      if (failHandle) throw new Error('handle setup failed');
      return { handle: opaqueHandle };
    },
    async getMetadata() { return { displayName: 'safe.pdf', size: 42, sha256: 'd'.repeat(64) }; },
    async readRange(_handle, { length }) { return Buffer.alloc(length, 0x41); },
    revokeActivation(id, reason) { calls.handleRevokes.push([id, reason]); return 1; },
  };
  return { packages, grants, handles, calls };
}

function deterministicBytes(size) {
  return Buffer.alloc(size, size === 32 ? 0xbb : 0xaa);
}

test('one-shot operation binds signed package, grant, opaque handle, and RPC then revokes once', async () => {
  const setup = fixture();
  const session = await createPluginOperationSession({
    ...setup,
    pluginId,
    documentId: 'document-private-id',
    permissions: ['document.metadata'],
    methods: ['document.getMetadata'],
    randomBytesImpl: deterministicBytes,
    audit: (event) => setup.calls.audit.push(event),
  });
  assert.equal(session.launchDescriptor.digest, packageHash);
  assert.equal(session.documentHandle, opaqueHandle);
  assert.equal(session.binding.nonce, 'bb'.repeat(32));
  assert.equal(JSON.stringify(session).includes('document-private-id'), false);
  assert.equal(session.createInvocation('document.example', { pages: [1] }).documentHandle, opaqueHandle);
  assert.throws(() => session.createInvocation('document.attacker', {}), { code: 'PLUGIN_WORKER_CAPABILITY_UNDECLARED' });

  const request = {
    protocol: 1,
    nonce: session.binding.nonce,
    pluginId,
    version: '1.0.0',
    packageHash,
    activationId: session.binding.activationId,
    type: 'request',
    id: 'request_1',
    sequence: 1,
    method: 'document.getMetadata',
    params: { handle: opaqueHandle },
  };
  const result = decodePluginRpcFrame(await session.processFrame(encodePluginRpcFrame(request)));
  assert.equal(result.value.displayName, 'safe.pdf');
  assert.equal(session.close('test-complete'), true);
  assert.equal(session.close('ignored-repeat'), false);
  assert.equal(setup.calls.grantRevokes.length, 1);
  assert.equal(setup.calls.handleRevokes.length, 1);
  assert.deepEqual(setup.calls.audit.map(({ type }) => type), ['plugin.operation.opened', 'plugin.operation.closed']);
});

test('setup failure revokes all activation-scoped authority', async () => {
  const setup = fixture({ failHandle: true });
  await assert.rejects(createPluginOperationSession({
    ...setup,
    pluginId,
    documentId: 'document-private-id',
    permissions: ['document.metadata'],
    methods: ['document.getMetadata'],
    randomBytesImpl: deterministicBytes,
  }), /handle setup failed/);
  assert.equal(setup.calls.grantRevokes.length, 1);
  assert.equal(setup.calls.handleRevokes.length, 1);
  assert.equal(setup.calls.grantRevokes[0][1], 'setup-failed');
});

test('cancellation during grant issuance revokes the transient grant before any handle is issued', async () => {
  const setup = fixture();
  const controller = new AbortController();
  setup.grants.issue = async (request) => {
    setup.calls.grantIssues.push(request);
    controller.abort();
    return { grantId: 'pg_test' };
  };
  await assert.rejects(createPluginOperationSession({
    ...setup,
    pluginId,
    documentId: 'document-private-id',
    permissions: ['document.metadata'],
    methods: ['document.getMetadata'],
    randomBytesImpl: deterministicBytes,
    signal: controller.signal,
  }), { code: 'PLUGIN_WORKER_CANCELLED', status: 499 });
  assert.equal(setup.calls.grantIssues.length, 1);
  assert.equal(setup.calls.handleIssues.length, 0);
  assert.equal(setup.calls.grantRevokes.length, 1);
  assert.equal(setup.calls.handleRevokes.length, 1);
});

test('broker validation and opened-audit failures remain inside the setup cleanup transaction', async () => {
  const invalidLimits = fixture();
  await assert.rejects(createPluginOperationSession({
    ...invalidLimits,
    pluginId,
    documentId: 'document-private-id',
    permissions: ['document.metadata'],
    methods: ['document.getMetadata'],
    rpcLimits: { maxInFlight: 0 },
    randomBytesImpl: deterministicBytes,
  }), /RPC limits must contain supported positive integers/);
  assert.equal(invalidLimits.calls.handleRevokes.length, 1);
  assert.equal(invalidLimits.calls.grantRevokes.length, 1);

  const auditFailure = fixture();
  await assert.rejects(createPluginOperationSession({
    ...auditFailure,
    pluginId,
    documentId: 'document-private-id',
    permissions: ['document.metadata'],
    methods: ['document.getMetadata'],
    randomBytesImpl: deterministicBytes,
    audit: (event) => {
      auditFailure.calls.audit.push(event);
      if (event.type === 'plugin.operation.opened') throw new Error('opened audit failed');
    },
  }), /opened audit failed/);
  assert.equal(auditFailure.calls.handleRevokes.length, 1);
  assert.equal(auditFailure.calls.grantRevokes.length, 1);
  assert.deepEqual(auditFailure.calls.audit.map(({ type }) => type), [
    'plugin.operation.opened', 'plugin.operation.closed',
  ]);
});

test('one-shot runtime rejects package dependency graphs before issuing authority', async () => {
  const descriptor = launchDescriptor({
    manifest: Object.freeze({
      manifestVersion: 3, id: pluginId, version: '1.0.0', entry: 'index.js', capabilities: ['document.example'],
      runtime: Object.freeze({ kind: 'javascriptcore-classic-script', apiVersion: 1 }),
      dependencies: [{ id: 'org.example.child' }],
    }),
    dependencies: Object.freeze([{ id: 'org.example.child', version: '1.0.0', digest: 'e'.repeat(64) }]),
  });
  const setup = fixture({ descriptor });
  await assert.rejects(createPluginOperationSession({
    ...setup,
    pluginId,
    documentId: 'document-private-id',
    permissions: ['document.metadata'],
    methods: ['document.getMetadata'],
  }), { code: 'PLUGIN_RUNTIME_DEPENDENCIES_DISABLED', status: 409 });
  assert.equal(setup.calls.grantIssues.length, 0);
  assert.equal(setup.calls.handleIssues.length, 0);
});

test('launch descriptor validation rejects unpinned paths and unexpected fields before grants', async () => {
  for (const descriptor of [
    launchDescriptor({ packageHash: 'f'.repeat(64) }),
    launchDescriptor({ entryPath: '/private/session/other/index.js' }),
    launchDescriptor({ untrusted: true }),
  ]) {
    const setup = fixture({ descriptor });
    await assert.rejects(createPluginOperationSession({
      ...setup,
      pluginId,
      documentId: 'document-private-id',
      permissions: ['document.metadata'],
      methods: ['document.getMetadata'],
    }), { code: 'PLUGIN_LAUNCH_DESCRIPTOR_INVALID', status: 500 });
    assert.equal(setup.calls.grantIssues.length, 0);
  }
});

test('cleanup attempts both revocation authorities and reports partial cleanup failure', async () => {
  const setup = fixture();
  let failOnce = true;
  setup.handles.revokeActivation = (id, reason) => {
    setup.calls.handleRevokes.push([id, reason]);
    if (failOnce) {
      failOnce = false;
      throw new Error('handle revocation failed');
    }
    return 0;
  };
  const session = await createPluginOperationSession({
    ...setup,
    pluginId,
    documentId: 'document-private-id',
    permissions: ['document.metadata'],
    methods: ['document.getMetadata'],
    randomBytesImpl: deterministicBytes,
  });
  assert.throws(() => session.close('test-cleanup'), { code: 'PLUGIN_OPERATION_CLEANUP_FAILED', status: 500 });
  assert.equal(setup.calls.handleRevokes.length, 1);
  assert.equal(setup.calls.grantRevokes.length, 1);
  assert.equal(session.close('repeat'), false);
  assert.equal(setup.calls.handleRevokes.length, 2);
  assert.equal(setup.calls.grantRevokes.length, 2);
  assert.equal(session.close('closed-repeat'), false);
  assert.equal(setup.calls.handleRevokes.length, 2);
});
