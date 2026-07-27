import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PublisherTrustAuthority } from '../scripts/host/publisher-trust-authority.mjs';

function key() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ type: 'spki', format: 'pem' });
}

function enrollment(keyId = 'one') {
  return {
    publisherId: 'org.example', keyId, publicKey: key(), pluginIds: [`org.example.${keyId}`],
  };
}

async function root() { return mkdtemp(join(tmpdir(), 'pdf-publisher-trust-test-')); }

test('publisher trust authority persists public projections and restores verification state', async () => {
  const base = await root(); const trustRoot = join(base, 'trust'); const input = enrollment();
  const first = await new PublisherTrustAuthority({ root: trustRoot }).initialize();
  const enrolled = await first.enroll(input);
  assert.equal(JSON.stringify(enrolled).includes('PUBLIC KEY'), false);
  assert.equal(JSON.stringify(await first.list()).includes('PUBLIC KEY'), false);
  const metadata = await lstat(join(trustRoot, 'trusted-publishers.json'));
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal((await lstat(trustRoot)).mode & 0o777, 0o700);
  const restored = await new PublisherTrustAuthority({ root: trustRoot }).initialize();
  assert.deepEqual(await restored.list(), await first.list());
  assert.ok(restored.store.get('org.example', 'one'));
});

test('publisher trust mutations serialize, revocation is idempotent, and removal requires fingerprint', async () => {
  const trust = await new PublisherTrustAuthority({ root: join(await root(), 'trust') }).initialize();
  const inputs = [enrollment('one'), enrollment('two'), enrollment('three')];
  await Promise.all(inputs.map((input) => trust.enroll(input)));
  const fingerprint = (await trust.list()).publishers[0].fingerprint;
  await trust.revoke({ publisherId: 'org.example', keyId: 'one' });
  await trust.revoke({ publisherId: 'org.example', keyId: 'one' });
  await trust.unrevoke({ publisherId: 'org.example', keyId: 'one' });
  await assert.rejects(
    trust.remove({ publisherId: 'org.example', keyId: 'one', fingerprint: '0'.repeat(64) }),
    { code: 'TRUST_KEY_FINGERPRINT_MISMATCH', status: 409 },
  );
  await trust.remove({ publisherId: 'org.example', keyId: 'one', fingerprint });
  assert.equal((await trust.list()).publishers.some(({ keyId }) => keyId === 'one'), false);
});

test('publisher trust authority fails closed on corrupted, symlinked, hard-linked, or unsafe state', async () => {
  const base = await root(); const trustRoot = join(base, 'trust');
  const authority = await new PublisherTrustAuthority({ root: trustRoot }).initialize();
  await authority.enroll(enrollment());
  const statePath = join(trustRoot, 'trusted-publishers.json');
  const bytes = await readFile(statePath, 'utf8');
  await writeFile(statePath, `${bytes.slice(0, -1)} `);
  await assert.rejects(new PublisherTrustAuthority({ root: trustRoot }).initialize(), { code: 'TRUST_STATE_INVALID' });
  await writeFile(statePath, bytes);
  await chmod(statePath, 0o644);
  await assert.rejects(new PublisherTrustAuthority({ root: trustRoot }).initialize(), { code: 'TRUST_STATE_UNSAFE' });

  const linkedRoot = join(base, 'linked'); const linkedAuthority = await new PublisherTrustAuthority({ root: linkedRoot }).initialize();
  await linkedAuthority.enroll(enrollment());
  await link(join(linkedRoot, 'trusted-publishers.json'), join(linkedRoot, 'state-hardlink'));
  await assert.rejects(new PublisherTrustAuthority({ root: linkedRoot }).initialize(), { code: 'TRUST_STATE_UNSAFE' });

  const symlinkRoot = join(base, 'symlink');
  await symlink(trustRoot, symlinkRoot);
  await assert.rejects(new PublisherTrustAuthority({ root: symlinkRoot }).initialize(), { code: 'TRUST_ROOT_UNSAFE' });
});
