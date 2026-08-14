import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  parseSignatureTrustResponse,
  SignatureTrustAdapter,
} from '../scripts/host/adapters/signature-trust.mjs';
import {
  stageSignatureTrustHelper,
  verifyStagedSignatureTrustHelper,
} from '../scripts/host/signature-trust-helper-loader.mjs';

const digest = 'a'.repeat(64);
const evaluatedAt = '2026-07-19T10:00:00.000Z';
const machOFixture = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('signature trust helper')]);

function response(records = []) {
  return JSON.stringify({
    version: 1,
    ok: true,
    result: {
      schema: 'macos-signature-chain-receipt-v2',
      profile: 'macos-basic-x509-current-trust-v2',
      sourceSha256: digest,
      evaluatedAt,
      verificationTimeBasis: 'host-current-time',
      anchorBasis: 'current-macos-trust-configuration',
      certificateNetworkFetchAllowed: false,
      records,
    },
  });
}

function record({
  byteRange = [0, 100, 200, 50],
  subFilter = 'adbe.pkcs7.detached',
  status = 'passes',
  reason = 'none',
  chainLength = 2,
  cmsSha256 = digest,
} = {}) {
  return { byteRange, subFilter, cmsSha256, certificateChain: { status, reason, chainLength } };
}

test('signature trust parser accepts only orthogonal bounded certificate-path evidence', () => {
  const parsed = parseSignatureTrustResponse(response([
    record(),
    record({ byteRange: [0, 120, 240, 60], status: 'fails', reason: 'not-trusted', chainLength: 1 }),
    record({ byteRange: [0, 140, 280, 70], status: 'indeterminate', reason: 'malformed-cms', chainLength: null }),
    record({ byteRange: [0, 160, 320, 80], status: 'unsupported', reason: 'unsupported-subfilter', chainLength: null }),
    record({ byteRange: [0, 180, 360, 90], status: 'indeterminate', reason: 'cms-signature-mismatch', chainLength: null }),
  ]));
  assert.equal(parsed.records.length, 5);
  assert.equal(parsed.certificateNetworkFetchAllowed, false);
  assert.equal(Object.isFrozen(parsed.records), true);
  assert.equal(Object.isFrozen(parsed.records[0].certificateChain), true);
  assert.throws(() => parseSignatureTrustResponse(response([
    record(), record(),
  ])), { code: 'SIGNATURE_TRUST_RESPONSE_INVALID' });
  assert.throws(() => parseSignatureTrustResponse(response([
    record({ status: 'passes', reason: 'not-trusted' }),
  ])), { code: 'SIGNATURE_TRUST_RESPONSE_INVALID' });
  assert.throws(() => parseSignatureTrustResponse(response([
    record({ byteRange: [1, 100, 200, 50] }),
  ])), { code: 'SIGNATURE_TRUST_RESPONSE_INVALID' });
  const extra = JSON.parse(response());
  extra.result.raw = '/private/input.pdf';
  assert.throws(() => parseSignatureTrustResponse(JSON.stringify(extra)), {
    code: 'SIGNATURE_TRUST_RESPONSE_INVALID',
  });
  assert.throws(() => parseSignatureTrustResponse(JSON.stringify({
    version: 1, ok: false, error: { code: 'PRIVATE_PATH', detail: '/private/input.pdf' },
  })), { code: 'SIGNATURE_TRUST_RESPONSE_INVALID' });
});

test('signature trust adapter pins helper, request, cwd, argv, and process bounds', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'signature-trust-adapter-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await chmod(workspace, 0o700);
  const requestPath = join(workspace, 'request.json');
  await writeFile(requestPath, '{}', { mode: 0o400 });
  const verifications = [];
  const calls = [];
  const adapter = new SignatureTrustAdapter({
    executable: '/private/pinned/pdf-signature-trust',
    expectedSha256: digest,
    verifyExecutable: async (value) => verifications.push(value),
    runner: async (value) => {
      calls.push(value);
      return { stdout: response([record()]), stderr: '', exitCode: 0 };
    },
  });
  const result = await adapter.evaluate({ workspacePath: workspace, requestPath }, { timeoutMs: 1_000 });
  assert.equal(result.records[0].certificateChain.status, 'passes');
  assert.deepEqual(verifications, [{
    executable: '/private/pinned/pdf-signature-trust', expectedSha256: digest,
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, '/private/pinned/pdf-signature-trust');
  assert.deepEqual(calls[0].args, ['--request', await realpath(requestPath)]);
  assert.equal(calls[0].cwd, await realpath(workspace));
  assert.equal(calls[0].timeoutMs, 1_000);
  assert.equal(calls[0].maxStdoutBytes, 256 * 1024);
  assert.equal(calls[0].maxStderrBytes, 64 * 1024);
  assert.equal('environment' in calls[0], false);
  assert.equal('stdin' in calls[0], false);

  await rm(requestPath);
  const target = join(workspace, 'target.json');
  await writeFile(target, '{}', { mode: 0o400 });
  await symlink(target, requestPath);
  await assert.rejects(
    adapter.evaluate({ workspacePath: workspace, requestPath }),
    /requestPath must be the bounded private request\.json/u,
  );
});

test('signature trust helper loader stages and re-verifies a distinct pinned Mach-O', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'signature-trust-project-'));
  const sessionRoot = await mkdtemp(join(tmpdir(), 'signature-trust-session-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(sessionRoot, { recursive: true, force: true }),
  ]));
  await Promise.all([chmod(root, 0o700), chmod(sessionRoot, 0o700)]);
  const source = join(root, 'native/pdfkit-helper/bin/pdf-signature-trust');
  await mkdir(dirname(source), { recursive: true, mode: 0o700 });
  await writeFile(source, machOFixture, { mode: 0o755 });
  const staged = await stageSignatureTrustHelper({ root, sessionRoot, platform: 'darwin' });
  assert.equal(staged.available, true);
  assert.equal(staged.kind, 'packaged');
  assert.match(staged.executable, /helpers\/pdf-signature-trust$/u);
  assert.equal(await verifyStagedSignatureTrustHelper({
    executable: staged.executable, expectedSha256: staged.sha256,
  }), true);
  await chmod(staged.executable, 0o700);
  await writeFile(staged.executable, Buffer.concat([machOFixture, Buffer.from('changed')]));
  await assert.rejects(verifyStagedSignatureTrustHelper({
    executable: staged.executable, expectedSha256: staged.sha256,
  }));
});
