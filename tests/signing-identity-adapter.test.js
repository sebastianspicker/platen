import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  parseSigningIdentityCreateDetachedCmsResponse,
  parseSigningIdentityListResponse,
  parseSigningIdentityVerifyDetachedCmsResponse,
  SigningIdentityAdapter,
} from '../scripts/host/adapters/signing-identity.mjs';
import {
  stageSigningIdentityHelper,
  verifyStagedSigningIdentityHelper,
} from '../scripts/host/signing-identity-helper-loader.mjs';

const digest = 'a'.repeat(64);
const machOFixture = Buffer.concat([
  Buffer.from('cffaedfe', 'hex'),
  Buffer.from('pdf signing identity helper'),
]);

function listResponse(entries = []) {
  return JSON.stringify({
    version: 1,
    ok: true,
    result: {
      operation: 'listSigningIdentities',
      identities: entries,
    },
  });
}

function cmsResponse(overrides = {}) {
  return JSON.stringify({
    version: 1,
    ok: true,
    result: Object.freeze({
      operation: 'createDetachedCMS',
      certificateSha256: digest,
      inputSha256: digest,
      cmsSha256: digest,
      cmsBytes: 1,
      outputFilename: 'detached.cms',
      ...overrides,
    }),
  });
}

function verifyResponse(overrides = {}) {
  return JSON.stringify({
    version: 1,
    ok: true,
    result: {
      operation: 'verifyDetachedCMS',
      inputSha256: digest,
      cmsSha256: digest,
      certificateSha256: digest,
      signatureValid: true,
      trustStatus: 'fails',
      trustReason: 'not-trusted',
      timestampValidated: false,
      ltv: false,
      revocationOnlineChecked: false,
      ...overrides,
    },
  });
}

function identity(bytes = 1, hash = digest) {
  return { certificateSha256: hash, certificateBytes: bytes };
}


test('signing-identity parser accepts strict bounded v1 envelopes', () => {
  const sorted = parseSigningIdentityListResponse(listResponse([
    identity(2, digest),
    identity(1, `${'f'.repeat(63)}0`),
  ]));
  assert.equal(sorted.ok, true);
  assert.equal(sorted.result.identities[0].certificateSha256, digest);
  assert.equal(Object.isFrozen(sorted.result.identities), true);

  assert.throws(() => parseSigningIdentityListResponse(listResponse([
    identity(1, digest),
    identity(1, digest),
  ])), { code: 'SIGNING_IDENTITY_RESPONSE_INVALID' });

  assert.throws(() => parseSigningIdentityListResponse(listResponse([
    identity(1, digest),
    { ...identity(1, digest.replace(/a/u, 'B')), certificateSha256: digest.toUpperCase() },
  ])), { code: 'SIGNING_IDENTITY_RESPONSE_INVALID' });

  assert.throws(() => parseSigningIdentityCreateDetachedCmsResponse(cmsResponse({
    cmsSha256: digest.toUpperCase(),
  })), { code: 'SIGNING_IDENTITY_RESPONSE_INVALID' });

  assert.throws(() => parseSigningIdentityCreateDetachedCmsResponse(JSON.stringify({
    version: 1,
    ok: false,
    error: { code: 'IDENTITY_NOT_FOUND' },
  })), { code: 'SIGNING_IDENTITY_IDENTITY_NOT_FOUND' });

  assert.equal(parseSigningIdentityCreateDetachedCmsResponse(cmsResponse()).result.outputFilename, 'detached.cms');
  const verified = parseSigningIdentityVerifyDetachedCmsResponse(verifyResponse());
  assert.equal(verified.result.signatureValid, true);
  assert.equal(verified.result.revocationOnlineChecked, false);
  assert.throws(() => parseSigningIdentityVerifyDetachedCmsResponse(verifyResponse({ trustStatus: 'indeterminate' })), {
    code: 'SIGNING_IDENTITY_RESPONSE_INVALID',
  });
  for (const code of ['CMS_INVALID', 'CMS_MULTIPLE_SIGNERS', 'TRUST_INDETERMINATE']) {
    assert.throws(() => parseSigningIdentityVerifyDetachedCmsResponse(JSON.stringify({
      version: 1,
      ok: false,
      error: { code },
    })), { code: `SIGNING_IDENTITY_${code}` });
  }
});

test('signing identity adapter pins helper/request/cwd and preserves helper error contracts', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'signing-identity-adapter-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await chmod(workspace, 0o700);
  const requestPath = join(workspace, 'request.json');
  await writeFile(requestPath, '{}', { mode: 0o400 });

  const calls = [];
  const verify = [];
  const adapter = new SigningIdentityAdapter({
    executable: '/private/pinned/pdf-signing-identity',
    expectedSha256: digest,
    verifyExecutable: async ({ executable, expectedSha256 }) => {
      verify.push({ executable, expectedSha256: expectedSha256.toLowerCase() });
    },
    runner: async (value) => {
      calls.push(value);
      return { stdout: listResponse([identity(1, `${'c'.repeat(63)}1`)]), stderr: '', exitCode: 0 };
    },
  });

  const result = await adapter.listIdentities({ workspacePath: workspace, requestPath });
  assert.equal(result.result.identities.length, 1);
  assert.deepEqual(verify, [{ executable: '/private/pinned/pdf-signing-identity', expectedSha256: digest }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, '/private/pinned/pdf-signing-identity');
  assert.deepEqual(calls[0].args, ['--request', await realpath(requestPath)]);
  assert.equal(calls[0].cwd, await realpath(workspace));
  assert.equal(calls[0].maxStdoutBytes, 262144);
  assert.equal(calls[0].maxStderrBytes, 65536);
  assert.equal('environment' in calls[0], false);
  assert.equal('stdin' in calls[0], false);

  await rm(requestPath);
  const target = join(workspace, 'target.json');
  await writeFile(target, '{}', { mode: 0o400 });
  await symlink(target, requestPath);
  await assert.rejects(
    adapter.listIdentities({ workspacePath: workspace, requestPath }),
    /requestPath must be the bounded private request\.json file directly inside workspacePath/u,
  );
  await rm(requestPath);
  await writeFile(requestPath, '{}', { mode: 0o400 });

  const untrusted = new SigningIdentityAdapter({
    executable: '/private/pinned/pdf-signing-identity',
    expectedSha256: digest,
    verifyExecutable: async () => {
      throw new Error('helper untrusted');
    },
    runner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  await assert.rejects(untrusted.listIdentities({ workspacePath: workspace, requestPath }), {
    code: 'SIGNING_IDENTITY_HELPER_UNTRUSTED',
  });
});

test('signing identity adapter enforces detached CMS bounds and helper error provenance', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'signing-identity-cms-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await chmod(workspace, 0o700);
  const input = Buffer.from('signed cms fixture');
  const inputSha = createHash('sha256').update(input).digest('hex');
  const requestPath = join(workspace, 'request.json');
  await writeFile(requestPath, '{}', { mode: 0o400 });
  await writeFile(join(workspace, 'detached.cms'), input, { mode: 0o600 });

  const adapter = new SigningIdentityAdapter({
    executable: '/private/pinned/pdf-signing-identity',
    expectedSha256: digest,
    verifyExecutable: async () => {},
    runner: async () => ({
      stdout: cmsResponse({
        cmsSha256: inputSha,
        cmsBytes: input.length,
      }),
      stderr: '',
      exitCode: 0,
    }),
  });

  const result = await adapter.createDetachedCms({ workspacePath: workspace, requestPath });
  assert.equal(result.result.cmsBytes, input.length);

  const failing = new SigningIdentityAdapter({
    executable: '/private/pinned/pdf-signing-identity',
    expectedSha256: digest,
    verifyExecutable: async () => {},
    runner: async () => ({
      stdout: cmsResponse({
        cmsSha256: inputSha,
        cmsBytes: input.length,
      }),
      stderr: '',
      exitCode: 0,
    }),
  });
  await writeFile(join(workspace, 'detached.cms'), Buffer.from('mismatch payload'), { mode: 0o600 });
  await assert.rejects(failing.createDetachedCms({ workspacePath: workspace, requestPath }), {
    code: 'SIGNING_IDENTITY_HELPER_FAILED',
  });
  const symlinked = new SigningIdentityAdapter({
    executable: '/private/pinned/pdf-signing-identity',
    expectedSha256: digest,
    verifyExecutable: async () => {},
    runner: async () => ({
      stdout: cmsResponse({
        cmsSha256: inputSha,
        cmsBytes: input.length,
      }),
      stderr: '',
      exitCode: 0,
    }),
  });
  const replacement = join(workspace, 'detached.cms.target');
  await writeFile(replacement, Buffer.from('another payload'), { mode: 0o600 });
  await rm(join(workspace, 'detached.cms'));
  await symlink(replacement, join(workspace, 'detached.cms'));
  await assert.rejects(symlinked.createDetachedCms({ workspacePath: workspace, requestPath }), {
    code: 'SIGNING_IDENTITY_HELPER_FAILED',
  });

  const denied = new SigningIdentityAdapter({
    executable: '/private/pinned/pdf-signing-identity',
    expectedSha256: digest,
    verifyExecutable: async () => {},
    runner: async () => ({
      stdout: JSON.stringify({
        version: 1,
        ok: false,
        error: { code: 'PLATFORM_DENIED' },
      }),
      stderr: '',
      exitCode: 0,
    }),
  });
  await writeFile(join(workspace, 'detached.cms'), input, { mode: 0o600 });
  await assert.rejects(denied.createDetachedCms({ workspacePath: workspace, requestPath }), {
    code: 'SIGNING_IDENTITY_PLATFORM_DENIED',
  });
});

test('signing identity adapter verifies detached CMS inputs with stable private-file checks', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'signing-identity-verify-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await chmod(workspace, 0o700);
  const input = Buffer.from('detached input');
  const cms = Buffer.from('detached cms');
  const inputSha256 = createHash('sha256').update(input).digest('hex');
  const cmsSha256 = createHash('sha256').update(cms).digest('hex');
  const requestPath = join(workspace, 'request.json');
  await writeFile(requestPath, '{}', { mode: 0o400 });
  await writeFile(join(workspace, 'input.bin'), input, { mode: 0o600 });
  await writeFile(join(workspace, 'detached.cms'), cms, { mode: 0o600 });
  const adapter = new SigningIdentityAdapter({
    executable: '/private/pinned/pdf-signing-identity',
    expectedSha256: digest,
    verifyExecutable: async () => {},
    runner: async () => ({
      stdout: verifyResponse({ inputSha256, cmsSha256 }), stderr: '', exitCode: 0,
    }),
  });
  const result = await adapter.verifyDetachedCms({ workspacePath: workspace, requestPath });
  assert.equal(result.result.inputSha256, inputSha256);
  assert.equal(result.result.cmsSha256, cmsSha256);

  await writeFile(join(workspace, 'detached.cms'), Buffer.from('tampered'), { mode: 0o600 });
  await assert.rejects(adapter.verifyDetachedCms({ workspacePath: workspace, requestPath }), {
    code: 'SIGNING_IDENTITY_HELPER_FAILED',
  });
});

test('signing identity helper loader stages and re-verifies a distinct pinned Mach-O', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'signing-identity-project-'));
  const sessionRoot = await mkdtemp(join(tmpdir(), 'signing-identity-session-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(sessionRoot, { recursive: true, force: true }),
  ]));
  await Promise.all([chmod(root, 0o700), chmod(sessionRoot, 0o700)]);
  const source = join(root, 'native/pdfkit-helper/bin/pdf-signing-identity');
  await mkdir(dirname(source), { recursive: true, mode: 0o700 });
  await writeFile(source, machOFixture, { mode: 0o755 });

  const staged = await stageSigningIdentityHelper({ root, sessionRoot, platform: 'darwin' });
  assert.equal(staged.available, true);
  assert.equal(staged.kind, 'packaged');
  assert.match(staged.executable, /helpers\/pdf-signing-identity$/u);
  assert.equal(await verifyStagedSigningIdentityHelper({
    executable: staged.executable,
    expectedSha256: staged.sha256,
  }), true);

  await chmod(staged.executable, 0o700);
  await writeFile(staged.executable, Buffer.concat([machOFixture, Buffer.from('changed')]));
  await assert.rejects(verifyStagedSigningIdentityHelper({
    executable: staged.executable,
    expectedSha256: staged.sha256,
  }));
});
