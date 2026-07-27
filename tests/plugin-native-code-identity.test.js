import assert from 'node:assert/strict';
import test from 'node:test';
import { DarwinPluginCodeIdentityVerifier, parseCodesignDetails } from '../scripts/host/plugin-native-code-identity.mjs';
import { nativeDesignatedRequirements } from '../scripts/host/plugin-native-supervisor-contract.mjs';

const team = 'ABCDE12345';
const requirements = nativeDesignatedRequirements(team);
const supervisor = Object.freeze({ executable: '/private/release/PDFPluginSupervisor', sha256: 'a'.repeat(64) });
const worker = Object.freeze({ executable: '/private/release/PDFPluginWorker', sha256: 'b'.repeat(64) });
const policy = Object.freeze({
  schema: 'pdf-plugin-native-release-policy-v1', version: 1, teamIdentifier: team,
  supervisorSha256: supervisor.sha256, workerSha256: worker.sha256,
  supervisorCdHash: 'c'.repeat(40), workerCdHash: 'd'.repeat(40),
  designatedRequirementSha256: requirements.sha256,
});

function details({ executable, identifier, cdHash, hardened = true, teamIdentifier = team } = {}) {
  const flags = hardened ? '0x10000(runtime)' : '0x0';
  return `Executable=${executable}\nIdentifier=${identifier}\nCodeDirectory v=20400 size=1 flags=${flags}\nCDHash=${cdHash}\nTeamIdentifier=${teamIdentifier}\n`;
}

function runner({ mutateDetails, entitlements = { 'com.apple.security.app-sandbox': true } } = {}) {
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    if (request.executable === '/usr/bin/plutil') return { stdout: JSON.stringify(entitlements), stderr: '' };
    const target = request.args.at(-1);
    if (request.args.includes('--verify')) return { stdout: '', stderr: '' };
    if (request.args.includes('--entitlements')) return { stdout: '<plist/>', stderr: '' };
    const isWorker = target.includes('Worker') || target === '+202';
    const base = {
      executable: isWorker ? worker.executable : supervisor.executable,
      identifier: isWorker ? 'org.platen.PDFPluginWorker' : 'org.platen.PDFPluginSupervisor',
      cdHash: isWorker ? policy.workerCdHash : policy.supervisorCdHash,
    };
    return { stdout: mutateDetails ? mutateDetails(details(base), request) : details(base), stderr: '' };
  };
  return { run, calls };
}

function verifier(options = {}) {
  const fake = runner(options);
  return { fake, value: new DarwinPluginCodeIdentityVerifier({ supervisor, worker, policy, runner: fake.run, platform: 'darwin' }) };
}

test('macOS verifier performs static requirements, display evidence, and exact sandbox entitlement checks', async () => {
  const { fake, value } = verifier();
  assert.equal(await value.verifyStaticPair(), true);
  assert.equal(fake.calls.filter((call) => call.args.includes('--verify')).length, 2);
  assert.equal(fake.calls.filter((call) => call.args.includes('--entitlements')).length, 2);
  assert.equal(fake.calls.filter((call) => call.executable === '/usr/bin/plutil').length, 2);
  assert.ok(fake.calls.filter((call) => call.args.includes('--verify')).every((call) => call.args.includes('--strict=all')));
});

test('static checks reject missing hardened runtime and entitlement widening', async () => {
  const runtime = verifier({ mutateDetails: (output) => output.replace('flags=0x10000(runtime)', 'flags=0x0') }).value;
  await assert.rejects(runtime.verifyStaticPair(), { code: 'PLUGIN_NATIVE_CODE_IDENTITY_FAILED', status: 503 });
  const entitlement = verifier({ entitlements: {
    'com.apple.security.app-sandbox': true, 'com.apple.security.network.client': true,
  } }).value;
  await assert.rejects(entitlement.verifyStaticPair(), { code: 'PLUGIN_NATIVE_CODE_IDENTITY_FAILED', status: 503 });
});

test('live PID checks bind the expected helper identity and fail closed on CDHash mismatch', async () => {
  const good = verifier().value;
  const evidence = await good.verifyLiveWorker({ pid: 202 });
  assert.equal(evidence.executable, worker.executable);
  assert.equal(evidence.cdHash, policy.workerCdHash);
  const bad = verifier({ mutateDetails: (output, request) => request.args.at(-1) === '+202'
    ? output.replace(policy.workerCdHash, 'f'.repeat(40)) : output }).value;
  await assert.rejects(bad.verifyLiveWorker({ pid: 202 }), { code: 'PLUGIN_NATIVE_CODE_IDENTITY_FAILED', status: 503 });
  await assert.rejects(good.verifyLiveSupervisor({ pid: 0 }), { code: 'PLUGIN_NATIVE_CODE_IDENTITY_FAILED', status: 503 });
});

test('codesign detail parser rejects ambiguous or malformed output', () => {
  assert.throws(() => parseCodesignDetails('Executable=/x\nIdentifier=x\n'), { code: 'PLUGIN_NATIVE_CODE_IDENTITY_FAILED' });
  assert.throws(() => parseCodesignDetails(details({ executable: '/x', identifier: 'x', cdHash: 'z'.repeat(40) })), {
    code: 'PLUGIN_NATIVE_CODE_IDENTITY_FAILED',
  });
});
