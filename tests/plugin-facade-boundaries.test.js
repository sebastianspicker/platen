import assert from 'node:assert/strict';
import test from 'node:test';
import * as packageFacade from '../scripts/host/plugin-package.mjs';
import * as packageContract from '../scripts/host/plugin-package-contract.mjs';
import {
  canonicalizePluginPackage,
  pluginPackageSignedPayload,
  sha256,
} from '../scripts/host/plugin-package-codec.mjs';
import { TrustedPublisherStore } from '../scripts/host/trusted-publisher-store.mjs';
import * as sandboxFacade from '../scripts/host/plugin-sandbox-darwin.mjs';
import {
  buildDarwinPluginProbeProfile,
} from '../scripts/host/plugin-sandbox-darwin-contract.mjs';

test('plugin package facade preserves its exact public API and split binding identities', () => {
  assert.deepEqual(Object.keys(packageFacade).sort(), [
    'PACKAGE_LIMITS',
    'TrustedPublisherStore',
    'canonicalizePluginPackage',
    'pluginPackageSignedPayload',
    'sha256',
    'verifyPluginPackage',
  ]);
  assert.equal(packageFacade.PACKAGE_LIMITS, packageContract.PACKAGE_LIMITS);
  assert.equal(packageFacade.canonicalizePluginPackage, canonicalizePluginPackage);
  assert.equal(packageFacade.pluginPackageSignedPayload, pluginPackageSignedPayload);
  assert.equal(packageFacade.sha256, sha256);
  assert.equal(packageFacade.TrustedPublisherStore, TrustedPublisherStore);
});

test('split package policy collections cannot be expanded by importers', () => {
  const policyValues = Object.values(packageContract)
    .filter((value) => Array.isArray(value) || value instanceof RegExp);
  assert.ok(policyValues.length > 10);
  for (const value of policyValues) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => packageContract.LOCAL_PERMISSIONS.push('network.fetch'), TypeError);
  assert.equal(packageContract.LOCAL_PERMISSIONS.includes('network.fetch'), false);
});

test('Darwin sandbox facade preserves its exact public API and profile binding', () => {
  assert.deepEqual(Object.keys(sandboxFacade).sort(), [
    'buildDarwinPluginProbeProfile',
    'inspectDarwinPluginSandbox',
  ]);
  assert.equal(
    sandboxFacade.buildDarwinPluginProbeProfile,
    buildDarwinPluginProbeProfile,
  );
});
