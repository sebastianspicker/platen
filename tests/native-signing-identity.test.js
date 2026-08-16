import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(root, 'native/pdfkit-helper');
const executable = join(packageRoot, '.build/debug/pdf-signing-identity');
const input = Buffer.from('bounded private signing fixture\n', 'utf8');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), 'pdf-signing-identity-native-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await chmod(path, 0o700);
  return path;
}

async function request(path, value, mode = 0o600) {
  const requestPath = join(path, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(value)}\n`, { mode });
  await chmod(requestPath, mode);
  return requestPath;
}

function run(path, requestPath = join(path, 'request.json')) {
  const result = spawnSync(executable, ['--request', requestPath], { cwd: path, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { text: result.stdout, response: JSON.parse(result.stdout) };
}

test('native signing-identity product builds and list responses are exact, bounded, and secret-free', async (t) => {
  const build = spawnSync('swift', [
    'build', '--package-path', packageRoot, '--product', 'pdf-signing-identity',
  ], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const packageFile = await readFile(join(packageRoot, 'Package.swift'), 'utf8');
  const verificationSource = await readFile(join(packageRoot, 'Sources/PDFSigningIdentity/Verification.swift'), 'utf8');
  assert.match(packageFile, /pdf-signing-identity/u);
  assert.doesNotMatch(packageFile.match(/name: "PDFSigningIdentity"[\s\S]*?\n\s*\),/u)?.[0] ?? '', /PDFKit|CoreGraphics|AppKit/u);
  assert.match(verificationSource, /SecTrustSetNetworkFetchAllowed\(trust, false\)/u);
  assert.match(verificationSource, /SecTrustGetNetworkFetchAllowed\(trust, &networkFetch\)/u);

  const path = await workspace(t);
  const requestPath = await request(path, { version: 1, operation: 'listSigningIdentities' });
  const { text, response } = run(path, requestPath);
  assert.equal(response.ok, true);
  assert.equal(response.version, 1);
  assert.deepEqual(Object.keys(response.result).sort(), ['identities', 'operation']);
  assert.equal(response.result.operation, 'listSigningIdentities');
  assert.ok(Array.isArray(response.result.identities));
  for (const identity of response.result.identities) {
    assert.deepEqual(Object.keys(identity).sort(), ['certificateBytes', 'certificateSha256']);
    assert.match(identity.certificateSha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isInteger(identity.certificateBytes) && identity.certificateBytes > 0 && identity.certificateBytes <= 65536);
  }
  assert.ok(Buffer.byteLength(text) <= 262144);
  assert.doesNotMatch(text, /BEGIN (?:CERTIFICATE|PRIVATE KEY)|\/private\/tmp|subject|issuer|keychain|password/iu);
});

test('native signing-identity protocol rejects malformed requests and unsafe private workspaces', async (t) => {
  const path = await workspace(t);
  await request(path, { version: 1, operation: 'listSigningIdentities', extra: false });
  assert.equal(run(path).response.error.code, 'INVALID_REQUEST');

  await request(path, { version: 1, operation: 'createDetachedCMS', inputFilename: 'wrong.bin', inputSha256: '0'.repeat(64), certificateSha256: '0'.repeat(64) });
  assert.equal(run(path).response.error.code, 'INVALID_REQUEST');

  await request(path, {
    version: 1,
    operation: 'verifyDetachedCMS',
    inputFilename: 'wrong.bin',
    inputSha256: '0'.repeat(64),
    cmsFilename: 'detached.cms',
    cmsSha256: '0'.repeat(64),
    certificateSha256: '0'.repeat(64),
  });
  assert.equal(run(path).response.error.code, 'INVALID_REQUEST');

  await request(path, { version: 1, operation: 'listSigningIdentities' }, 0o644);
  assert.equal(run(path).response.error.code, 'UNSAFE_WORKSPACE');
  await request(path, { version: 1, operation: 'listSigningIdentities' });
  const alias = join(path, 'request-alias.json');
  await symlink(join(path, 'request.json'), alias);
  assert.equal(run(path, alias).response.error.code, 'UNSAFE_WORKSPACE');

  await chmod(path, 0o755);
  await request(path, { version: 1, operation: 'listSigningIdentities' });
  assert.equal(run(path).response.error.code, 'UNSAFE_WORKSPACE');
  assert.equal((await lstat(path)).isDirectory(), true);
});

test('native detached-CMS contract validates private input and exact certificate selection', async (t) => {
  const path = await workspace(t);
  await writeFile(join(path, 'input.bin'), input, { mode: 0o600 });
  const identitiesRequest = await request(path, { version: 1, operation: 'listSigningIdentities' });
  const listed = run(path, identitiesRequest).response;
  assert.equal(listed.ok, true);
  // Never invoke an ambient keychain identity in the default test suite: signing
  // can legitimately require an interactive authorization prompt. The native
  // contract is still covered through exact selection and deterministic refusal.
  const certificateSha256 = '0'.repeat(64);
  const signRequest = {
    version: 1,
    operation: 'createDetachedCMS',
    inputFilename: 'input.bin',
    inputSha256: digest(input),
    certificateSha256,
  };
  await request(path, signRequest);
  const result = run(path);
  assert.equal(result.response.ok, false);
  assert.equal(result.response.error.code, 'IDENTITY_NOT_FOUND');
  assert.doesNotMatch(result.text, /BEGIN (?:CERTIFICATE|PRIVATE KEY)|private signing fixture|\/private\/tmp/iu);
});

test('native detached-CMS verification fails closed on digest drift and malformed CMS', async (t) => {
  const path = await workspace(t);
  await writeFile(join(path, 'input.bin'), input, { mode: 0o600 });
  const cms = Buffer.from('not a CMS payload', 'utf8');
  await writeFile(join(path, 'detached.cms'), cms, { mode: 0o600 });
  const verify = {
    version: 1,
    operation: 'verifyDetachedCMS',
    inputFilename: 'input.bin',
    inputSha256: digest(input),
    cmsFilename: 'detached.cms',
    cmsSha256: digest(cms),
    certificateSha256: '0'.repeat(64),
  };
  await request(path, verify);
  const malformed = run(path);
  assert.equal(malformed.response.ok, false);
  assert.equal(malformed.response.error.code, 'CMS_INVALID');
  assert.doesNotMatch(malformed.text, /BEGIN (?:CERTIFICATE|PRIVATE KEY)|not a CMS payload|subject|issuer/iu);

  await request(path, { ...verify, cmsSha256: '1'.repeat(64) });
  assert.equal(run(path).response.error.code, 'SOURCE_MISMATCH');
});
