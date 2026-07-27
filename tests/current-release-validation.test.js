import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_LOCAL_RELEASE_POLICY,
  validateCurrentLocalRelease,
} from '../scripts/release/validate-current-release.mjs';

test('current local release inventory passes without claiming external distribution evidence', async () => {
  const receipt = await validateCurrentLocalRelease();
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.scope, 'local-inventory');
  assert.equal(receipt.distributionStatus, 'not-ready');
  assert.equal(receipt.inventory.files.length, CURRENT_LOCAL_RELEASE_POLICY.requiredPaths.length);
  assert.equal(receipt.inventory.files.some(({ path }) => (
    path === 'scripts/host/automation/durable-local-job-queue.mjs'
  )), true);
  for (const path of [
    'scripts/host/automation/automation-sequence-contract.mjs',
    'scripts/host/automation/automation-sequence-execution.mjs',
    'scripts/host/automation/durable-local-job-policy-migration.mjs',
    'scripts/host/automation/durable-local-job-transactions.mjs',
  ]) assert.equal(receipt.inventory.files.some((file) => file.path === path), true);
  assert.equal(receipt.inventory.files.some(({ path }) => (
    path === 'scripts/host/pdf-classic-incremental-revision.mjs'
  )), true);
  assert.equal(receipt.inventory.files.some(({ path }) => (
    path === 'scripts/local-host.mjs'
  )), true);
  assert.deepEqual(receipt.checks.find(({ name }) => name === 'production-module-reachability'), {
    name: 'production-module-reachability', status: 'pass', code: null,
  });
  assert.ok(receipt.sourceInventory.reachableModules > 400);
  assert.ok(receipt.sourceInventory.nativeSourceFiles > 60);
  assert.ok(receipt.sourceInventory.intentionallyUnshippedModules > 0);
  for (const name of ['signing', 'notarization']) {
    assert.equal(receipt.checks.find((check) => check.name === name)?.status, 'not-checked');
  }
  assert.equal(receipt.checks.find((check) => check.name === 'sbom')?.status, 'pass');
});
