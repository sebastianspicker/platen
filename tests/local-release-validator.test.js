import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LOCAL_RELEASE_POLICY_SCHEMA, validateLocalRelease } from '../scripts/release/local-release-validator.mjs';

function policy(requiredPaths = ['README.md', 'package.json']) {
  return {
    schema: LOCAL_RELEASE_POLICY_SCHEMA,
    requiredPaths,
    package: { name: 'fixture-pdf', version: '1.2.3', nodeEngine: '>=20', license: 'MIT', private: true },
    limits: { maxDepth: 4, maxFiles: 8, maxFileBytes: 1024, maxTotalBytes: 2048 },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-release-validator-'));
  await writeFile(join(root, 'README.md'), 'local fixture\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-pdf', version: '1.2.3', engines: { node: '>=20' }, license: 'MIT', private: true,
    dependencies: {}, devDependencies: {}, optionalDependencies: {}, peerDependencies: {},
  }));
  return root;
}

test('local release validation returns a deterministic frozen receipt and explicitly leaves external evidence unchecked', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = await validateLocalRelease({ root, policy: policy() });
  const second = await validateLocalRelease({ root, policy: policy(['package.json', 'README.md']) });
  assert.deepEqual(first, second);
  assert.equal(first.schema, 'pdf-local-release-receipt-v2');
  assert.equal(first.scope, 'local-inventory');
  assert.equal(first.status, 'pass');
  assert.equal(first.distributionStatus, 'not-ready');
  assert.deepEqual(first.inventory.files.map((file) => file.path), ['package.json', 'README.md']);
  assert.equal(first.checks.find((check) => check.name === 'signing').status, 'not-checked');
  assert.equal(first.checks.find((check) => check.name === 'sbom').status, 'pass');
  assert.equal(first.sbom.schema, 'pdf-local-sbom-v1');
  assert.equal(first.sbom.files.length, 2);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.inventory.files[0]), true);
  assert.throws(() => { first.inventory.files[0].size = 0; }, TypeError);
});

test('local release validation rejects secret, traversal, symlink, hardlink, missing, and non-regular required paths without exposing local paths', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await symlink('README.md', join(root, 'link.md'));
  await link(join(root, 'README.md'), join(root, 'hardlink.md'));
  await mkdir(join(root, 'directory'));
  for (const requiredPaths of [['../README.md', 'package.json'], ['.env', 'package.json'], ['release-key.pem', 'package.json']]) {
    await assert.rejects(validateLocalRelease({ root, policy: policy(requiredPaths) }), { code: 'RELEASE_POLICY_INVALID' });
  }
  for (const name of ['link.md', 'hardlink.md', 'directory', 'missing.md']) {
    const receipt = await validateLocalRelease({ root, policy: policy([name, 'package.json']) });
    assert.equal(receipt.status, 'fail');
    const fileCheck = receipt.checks.find((check) => check.name === `required-file:${name}`);
    assert.match(fileCheck.code, /^RELEASE_FILE_(?:UNSAFE|MISSING)$/u);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('local release validation rejects a symlinked root and nested symlink ancestors without exposing local paths', async (context) => {
  const root = await fixture();
  const linkedRoot = `${root}-link`;
  context.after(async () => {
    await rm(linkedRoot, { force: true });
    await rm(root, { recursive: true, force: true });
  });
  await symlink(root, linkedRoot);
  await assert.rejects(validateLocalRelease({ root: linkedRoot, policy: policy() }), (error) => {
    assert.equal(error.code, 'RELEASE_ROOT_UNSAFE');
    assert.doesNotMatch(error.message, new RegExp(linkedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  await mkdir(join(root, 'actual'));
  await writeFile(join(root, 'actual', 'nested.md'), 'nested fixture\n');
  await symlink('actual', join(root, 'linked-directory'));
  const receipt = await validateLocalRelease({ root, policy: policy(['linked-directory/nested.md', 'package.json']) });
  assert.equal(receipt.status, 'fail');
  assert.deepEqual(receipt.checks.find((check) => check.name === 'required-file:linked-directory/nested.md'), {
    name: 'required-file:linked-directory/nested.md', status: 'fail', code: 'RELEASE_PATH_ANCESTOR_UNSAFE',
  });
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('local release validation fails metadata and declared dependencies without claiming external release completion', async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-pdf', version: '1.2.3', engines: { node: '>=20' }, license: 'MIT', private: true,
    dependencies: { example: '1.0.0' },
  }));
  const receipt = await validateLocalRelease({ root, policy: policy() });
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.distributionStatus, 'not-ready');
  assert.deepEqual(receipt.checks.find((check) => check.name === 'package-metadata'), { name: 'package-metadata', status: 'pass', code: null });
  assert.deepEqual(receipt.checks.find((check) => check.name === 'declared-dependencies'), { name: 'declared-dependencies', status: 'fail', code: 'RELEASE_DEPENDENCIES_DECLARED' });
  assert.equal(receipt.checks.find((check) => check.name === 'sbom').status, 'not-checked');
});
