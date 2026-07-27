import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRuntimeManifest } from '../src/core/validate.js';

function manifest(overrides = {}) {
  return {
    manifestVersion: 2,
    id: 'org.platen.example',
    name: 'Example',
    version: '1.0.0',
    protocolVersion: 1,
    entry: 'worker/plugin.mjs',
    capabilities: ['example.inspect'],
    permissions: [{ name: 'document.metadata', reason: 'Show document properties.' }],
    dependencies: [],
    activation: 'manual',
    ...overrides,
  };
}

test('runtime manifest validator accepts a strict local manifest', () => {
  const validated = validateRuntimeManifest(manifest());
  assert.deepEqual(validated, manifest());
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.permissions), true);
  assert.equal(Object.isFrozen(validated.permissions[0]), true);
});

test('runtime manifest rejects unknown fields and executable path escapes', () => {
  assert.throws(() => validateRuntimeManifest(manifest({ surprise: true })), { code: 'MANIFEST_INVALID' });
  for (const entry of ['../plugin.mjs', '%2e%2e/plugin.mjs', 'https://example.com/plugin.mjs', '/plugin.mjs', 'plugin.mjs?x=1', 'plugin.html', 'worker//plugin.mjs', './plugin.mjs', 'a/b/c/d/e/f/plugin.mjs']) {
    assert.throws(() => validateRuntimeManifest(manifest({ entry })), { code: 'MANIFEST_INVALID' });
  }
});

test('runtime manifest rejects duplicate or unsafe permission declarations', () => {
  const repeated = { name: 'document.metadata', reason: 'Read properties for display.' };
  assert.throws(() => validateRuntimeManifest(manifest({ permissions: [repeated, repeated] })), { code: 'MANIFEST_INVALID' });
  assert.throws(() => validateRuntimeManifest(manifest({ permissions: [{ name: 'network.fetch', reason: 'Call a remote service.', origins: ['https://*.example.com'] }] })), { code: 'MANIFEST_INVALID' });
});

test('runtime manifest requires exact versions and reverse-domain IDs', () => {
  assert.throws(() => validateRuntimeManifest(manifest({ version: '^1.0.0' })), { code: 'MANIFEST_INVALID' });
  assert.throws(() => validateRuntimeManifest(manifest({ id: 'example' })), { code: 'MANIFEST_INVALID' });
});
