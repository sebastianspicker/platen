import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { parseCliArguments, runCli } from '../scripts/platen-cli.mjs';
import { PublisherTrustAuthority } from '../scripts/host/publisher-trust-authority.mjs';
import { canonicalizePluginPackage, sha256 } from '../scripts/host/plugin-package-codec.mjs';

function capture() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function publicKeyFixture() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

async function runAllowlist(trustRoot, argv, applicationRoot) {
  const output = capture();
  await runCli(
    ['admin.plugin-allowlist', '--trust-root', trustRoot, ...argv],
    { applicationRoot, stdout: output.stream },
  );
  return output.text();
}

function enrollmentArgs(publicKeyPath, pluginIds = ['org.example.alpha', 'org.example.beta']) {
  return [
    '--action', 'enroll',
    '--publisher-id', 'org.example',
    '--key-id', 'release',
    '--public-key', publicKeyPath,
    '--plugin-id', pluginIds.join(','),
  ];
}

async function makeRoot(context, prefix = 'platen-admin-plugin-claim-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('local CLI trust-root claim excludes version allowlists, HTTP routes, and admin-role authorization', async (context) => {
  const root = await makeRoot(context);
  const trustRoot = join(root, 'trusted');
  const publicKeyPath = join(root, 'publisher-key.pem');
  await writeFile(publicKeyPath, publicKeyFixture(), { mode: 0o600 });

  const enrolledText = await runAllowlist(
    trustRoot,
    enrollmentArgs(publicKeyPath),
    root,
  );
  const enrolled = JSON.parse(enrolledText);
  assert.equal(enrolled.action, 'enroll');
  assert.equal(enrolled.localOnly, true);
  assert.deepEqual(enrolled.entry.pluginIds, ['org.example.alpha', 'org.example.beta']);
  assert.equal(enrolled.entry.revoked, false);
  assert.doesNotMatch(enrolledText, /BEGIN (?:PUBLIC|PRIVATE) KEY/u);
  assert.doesNotMatch(enrolledText, /publisher-key\.pem|trusted-publishers\.json/u);
  assert.equal(Object.hasOwn(enrolled.entry, 'version'), false);

  const statePath = join(trustRoot, 'trusted-publishers.json');
  const stateText = await readFile(statePath, 'utf8');
  const state = JSON.parse(stateText);
  assert.equal(JSON.stringify(state), stateText, 'persisted trust state is canonical JSON');
  assert.equal(
    state.stateSha256,
    sha256(canonicalizePluginPackage({
      schemaVersion: state.schemaVersion,
      publishers: state.publishers,
    })),
  );
  assert.equal((await lstat(trustRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(statePath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(trustRoot)).sort(), ['trusted-publishers.json']);
  assert.equal(typeof state.publishers[0].publicKey, 'string');

  const restored = await new PublisherTrustAuthority({ root: trustRoot }).initialize();
  assert.deepEqual(await restored.list(), enrolled.state);
  assert.ok(restored.store.get('org.example', 'release'));

  assert.throws(() => parseCliArguments([
    'admin.plugin-allowlist', '--action', 'enroll', '--trust-root', trustRoot,
    '--publisher-id', 'org.example', '--key-id', 'other', '--public-key', publicKeyPath,
    '--plugin-id', 'org.example.alpha,org.example.alpha',
  ]), { code: 'CLI_INVALID_OPTION' });
});

test('local CLI trust-root claim covers duplicate replay, idempotent revoke, unrevoke, and fingerprint-confirmed removal', async (context) => {
  const root = await makeRoot(context, 'platen-admin-plugin-replay-');
  const trustRoot = join(root, 'trusted');
  const publicKeyPath = join(root, 'publisher-key.pem');
  await writeFile(publicKeyPath, publicKeyFixture(), { mode: 0o600 });
  await runAllowlist(trustRoot, enrollmentArgs(publicKeyPath, ['org.example.plugin']), root);

  await assert.rejects(
    runAllowlist(trustRoot, enrollmentArgs(publicKeyPath, ['org.example.plugin']), root),
    { code: 'TRUST_KEY_EXISTS', status: 409 },
  );

  const revokedText = await runAllowlist(trustRoot, [
    '--action', 'revoke', '--publisher-id', 'org.example', '--key-id', 'release',
  ], root);
  assert.equal(JSON.parse(revokedText).entry.revoked, true);
  const repeatedRevokeText = await runAllowlist(trustRoot, [
    '--action', 'revoke', '--publisher-id', 'org.example', '--key-id', 'release',
  ], root);
  assert.equal(JSON.parse(repeatedRevokeText).entry.revoked, true);

  const unrevokeText = await runAllowlist(trustRoot, [
    '--action', 'unrevoke', '--publisher-id', 'org.example', '--key-id', 'release',
  ], root);
  assert.equal(JSON.parse(unrevokeText).entry.revoked, false);

  const fingerprint = JSON.parse(await runAllowlist(
    trustRoot,
    ['--action', 'list'],
    root,
  )).publishers[0].fingerprint;
  await assert.rejects(
    runAllowlist(trustRoot, [
      '--action', 'remove', '--publisher-id', 'org.example', '--key-id', 'release',
      '--expected-fingerprint', '0'.repeat(64),
    ], root),
    { code: 'TRUST_KEY_FINGERPRINT_MISMATCH', status: 409 },
  );
  const removedText = await runAllowlist(trustRoot, [
    '--action', 'remove', '--publisher-id', 'org.example', '--key-id', 'release',
    '--expected-fingerprint', fingerprint,
  ], root);
  assert.equal(JSON.parse(removedText).entry.removed, true);
  await assert.rejects(
    runAllowlist(trustRoot, [
      '--action', 'remove', '--publisher-id', 'org.example', '--key-id', 'release',
      '--expected-fingerprint', fingerprint,
    ], root),
    { code: 'TRUST_KEY_NOT_FOUND', status: 404 },
  );
});

test('local trust-root state corruption, hard links, and symlink roots fail closed', async (context) => {
  const root = await makeRoot(context, 'platen-admin-plugin-integrity-');
  const corruptRoot = join(root, 'corrupt');
  const authority = await new PublisherTrustAuthority({ root: corruptRoot }).initialize();
  await authority.enroll({
    publisherId: 'org.example',
    keyId: 'release',
    publicKey: publicKeyFixture(),
    pluginIds: ['org.example.plugin'],
  });
  const statePath = join(corruptRoot, 'trusted-publishers.json');
  const original = await readFile(statePath, 'utf8');
  await writeFile(statePath, `${original} `);
  await assert.rejects(
    new PublisherTrustAuthority({ root: corruptRoot }).initialize(),
    { code: 'TRUST_STATE_INVALID', status: 500 },
  );

  const linkedRoot = join(root, 'linked');
  const linkedAuthority = await new PublisherTrustAuthority({ root: linkedRoot }).initialize();
  await linkedAuthority.enroll({
    publisherId: 'org.example',
    keyId: 'release',
    publicKey: publicKeyFixture(),
    pluginIds: ['org.example.plugin'],
  });
  await link(
    join(linkedRoot, 'trusted-publishers.json'),
    join(linkedRoot, 'state-hardlink'),
  );
  await assert.rejects(
    new PublisherTrustAuthority({ root: linkedRoot }).initialize(),
    { code: 'TRUST_STATE_UNSAFE', status: 500 },
  );

  const symlinkRoot = join(root, 'symlink');
  await symlink(corruptRoot, symlinkRoot);
  await assert.rejects(
    new PublisherTrustAuthority({ root: symlinkRoot }).initialize(),
    { code: 'TRUST_ROOT_UNSAFE', status: 500 },
  );

  await chmod(statePath, 0o600);
  assert.equal((await readFile(statePath, 'utf8')).length, original.length + 1);
});
