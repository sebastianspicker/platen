import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { parseCliArguments, runCli } from '../scripts/platen-cli.mjs';

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

function ed25519PublicKeyFixture() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function quotedPath(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function runAdminPluginAllowlist(trustRoot, argv, options = {}) {
  const output = capture();
  await runCli(
    ['admin.plugin-allowlist', '--trust-root', trustRoot, ...argv],
    { ...options, stdout: output.stream },
  );
  return output.text();
}

test('plugin allowlist parser validates trust-root and action-specific allowlist constraints', () => {
  assert.deepEqual(parseCliArguments([
    'admin.plugin-allowlist', '--action', 'list', '--trust-root', 'trust-root',
  ]), {
    command: 'admin.plugin-allowlist',
    action: 'list',
    trustRoot: 'trust-root',
    output: null,
  });
  assert.deepEqual(parseCliArguments([
    'admin.plugin-allowlist', '--action', 'enroll', '--trust-root', 'trust-root',
    '--publisher-id', 'org.example', '--key-id', 'k1', '--public-key', 'key.pub',
    '--plugin-id', 'org.example.plugin',
  ]), {
    command: 'admin.plugin-allowlist',
    action: 'enroll',
    trustRoot: 'trust-root',
    publisherId: 'org.example',
    keyId: 'k1',
    publicKey: 'key.pub',
    pluginIds: ['org.example.plugin'],
    output: null,
  });
  assert.deepEqual(parseCliArguments([
    'admin.plugin-allowlist', '--action', 'remove', '--trust-root', 'trust-root',
    '--publisher-id', 'org.example', '--key-id', 'k1', '--expected-fingerprint', '0'.repeat(64),
  ]), {
    command: 'admin.plugin-allowlist',
    action: 'remove',
    trustRoot: 'trust-root',
    publisherId: 'org.example',
    keyId: 'k1',
    expectedFingerprint: '0'.repeat(64),
    output: null,
  });
  assert.throws(() => parseCliArguments([
    'admin.plugin-allowlist', '--action', 'list',
  ]), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments([
    'admin.plugin-allowlist', '--action', 'remove', '--trust-root', 'trust-root',
    '--publisher-id', 'org.example', '--key-id', 'k1',
  ]), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments([
    'admin.plugin-allowlist', '--action', 'remove', '--trust-root', 'trust-root',
    '--publisher-id', 'org.example', '--key-id', 'k1',
    '--expected-fingerprint', '0'.repeat(63),
  ]), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments([
    'admin.plugin-allowlist', '--action', 'remove', '--trust-root', 'trust-root',
    '--publisher-id', 'org.example', '--key-id', 'k1',
    '--expected-fingerprint', 'A'.repeat(64),
  ]), { code: 'CLI_INVALID_OPTION' });
});

test('plugin allowlist CLI persists state across runs and supports revoke/unrevoke/remove safely', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-plugin-allowlist-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const trustRoot = join(directory, 'trusted');
  const publicKeyPath = join(directory, 'publisher-key.pem');
  const publicKey = ed25519PublicKeyFixture();
  await writeFile(publicKeyPath, publicKey);
  const enrollArgs = [
    '--action', 'enroll',
    '--publisher-id', 'org.example',
    '--key-id', 'demo',
    '--public-key', publicKeyPath,
    '--plugin-id', 'org.example.plugin',
  ];
  const enrollText = await runAdminPluginAllowlist(trustRoot, enrollArgs, { applicationRoot: directory });
  assert.doesNotMatch(enrollText, new RegExp(quotedPath('BEGIN PUBLIC KEY'), 'u'));
  const enrolled = JSON.parse(enrollText);
  assert.deepEqual(enrolled.action, 'enroll');
  assert.equal(enrolled.localOnly, true);
  const listAfterEnrollText = await runAdminPluginAllowlist(trustRoot, ['--action', 'list'], { applicationRoot: directory });
  const listAfterEnroll = JSON.parse(listAfterEnrollText);
  assert.equal(listAfterEnroll.publishers.length, 1);
  assert.equal(listAfterEnroll.publishers[0].publisherId, 'org.example');
  assert.equal(listAfterEnroll.publishers[0].revoked, false);
  const revokeText = await runAdminPluginAllowlist(trustRoot, [
    '--action', 'revoke',
    '--publisher-id', 'org.example',
    '--key-id', 'demo',
  ], { applicationRoot: directory });
  const revoked = JSON.parse(revokeText);
  assert.equal(revoked.action, 'revoke');
  assert.equal(revoked.entry.revoked, true);
  const listAfterRevokeText = await runAdminPluginAllowlist(trustRoot, ['--action', 'list'], { applicationRoot: directory });
  assert.equal(JSON.parse(listAfterRevokeText).publishers[0].revoked, true);
  const unrevokeText = await runAdminPluginAllowlist(trustRoot, [
    '--action', 'unrevoke',
    '--publisher-id', 'org.example',
    '--key-id', 'demo',
  ], { applicationRoot: directory });
  const unrevoked = JSON.parse(unrevokeText);
  assert.equal(unrevoked.action, 'unrevoke');
  assert.equal(unrevoked.entry.revoked, false);
  const fingerprint = listAfterEnroll.publishers[0].fingerprint;
  const mismatchFingerprint = '0'.repeat(64);
  await assert.rejects(
    runAdminPluginAllowlist(trustRoot, [
      '--action', 'remove',
      '--publisher-id', 'org.example',
      '--key-id', 'demo',
      '--expected-fingerprint', mismatchFingerprint,
    ], { applicationRoot: directory }),
    { code: 'TRUST_KEY_FINGERPRINT_MISMATCH' },
  );
  const removeText = await runAdminPluginAllowlist(trustRoot, [
    '--action', 'remove',
    '--publisher-id', 'org.example',
    '--key-id', 'demo',
    '--expected-fingerprint', fingerprint,
  ], { applicationRoot: directory });
  const removed = JSON.parse(removeText);
  assert.equal(removed.action, 'remove');
  assert.equal(removed.entry.removed, true);
  assert.equal(removed.entry.keyId, 'demo');
  const finalList = JSON.parse(
    await runAdminPluginAllowlist(trustRoot, ['--action', 'list'], { applicationRoot: directory }),
  );
  assert.equal(finalList.publishers.length, 0);
  assert.doesNotMatch(removeText, new RegExp(quotedPath('PUBLIC KEY'), 'u'));
});
