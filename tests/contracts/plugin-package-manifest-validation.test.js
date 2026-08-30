import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePluginPackageManifest } from '../../src/host/application/plugins/plugin-package-manifest-validation.mjs';

function pluginPackage(manifest = {}) {
  return {
    packageVersion: 1,
    manifest: {
      manifestVersion: 1,
      id: 'example.plugin.local',
      name: 'Example extension metadata',
      version: '1.0.0',
      description: 'Signed metadata that describes an inert local extension record.',
      capabilities: ['review.metadata'],
      ...manifest,
    },
    signature: {},
  };
}

test('signed package manifest validation accepts inert metadata only', () => {
  const result = validatePluginPackageManifest(pluginPackage());
  assert.equal(result.manifest.id, 'example.plugin.local');
  assert.deepEqual(result.manifest.capabilities, ['review.metadata']);
});

for (const [label, shape] of [
  ['activation timing', { activation: 'on-capability' }],
  ['entrypoint', { entry: 'runtime.mjs' }],
  ['runtime declaration', { runtime: { kind: 'javascriptcore-classic-script', apiVersion: 1 } }],
  ['runtime provider', { provider: 'local.runtime' }],
  ['selected runtime provider', { selectedProviderId: 'local.runtime' }],
  ['loader', { loader: 'metadata-loader' }],
  ['dispatcher', { dispatcher: 'capability-dispatcher' }],
  ['RPC declaration', { rpc: { version: 1 } }],
  ['sandbox declaration', { sandbox: { mode: 'restricted' } }],
  ['code declaration', { code: 'export default {}' }],
  ['permission request', { permissions: [] }],
  ['dependency graph', { dependencies: [] }],
]) {
  test(`signed package manifest validation rejects ${label}`, () => {
    assert.throws(() => validatePluginPackageManifest(pluginPackage(shape)), {
      code: 'PACKAGE_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN',
    });
  });
}

test('signed package manifest validation rejects payload and code files', () => {
  for (const field of ['files', 'payload']) {
    const candidate = pluginPackage();
    candidate[field] = [{ path: 'runtime.mjs', mediaType: 'application/javascript', content: 'ZXhwb3J0IHt9' }];
    assert.throws(() => validatePluginPackageManifest(candidate), { code: 'PACKAGE_PAYLOAD_FORBIDDEN' });
  }
});
