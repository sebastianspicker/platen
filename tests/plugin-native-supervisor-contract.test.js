import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  decodeNativeReadyFrame, encodeNativeInvocationPhase, encodeNativePreparation,
  nativeDesignatedRequirements, unframeNativeCompletion, validateNativeExecutablePair,
  validateNativeLaunch, validateNativeReleasePolicy,
} from '../scripts/host/plugin-native-supervisor-contract.mjs';

const pluginId = 'org.platen.contract';
const source = Buffer.from('registerPlugin({invoke: (input) => input});');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const requirements = nativeDesignatedRequirements('ABCDE12345');
const policy = Object.freeze({
  schema: 'pdf-plugin-native-release-policy-v1', version: 1, teamIdentifier: 'ABCDE12345',
  supervisorSha256: 'a'.repeat(64), workerSha256: 'b'.repeat(64),
  supervisorCdHash: 'c'.repeat(40), workerCdHash: 'd'.repeat(40),
  designatedRequirementSha256: requirements.sha256,
});
const identity = Object.freeze({
  pluginId, version: '1.2.3', packageHash: 'e'.repeat(64), sourceSha256,
  runtime: Object.freeze({ kind: 'javascriptcore-classic-script', apiVersion: 1, entry: 'index.js', sha256: sourceSha256 }),
});
const booleans = [
  'staticCodeIdentity', 'liveCodeIdentity', 'appSandbox', 'noNetwork', 'cpuQuota',
  'hardMemoryQuota', 'processQuota', 'outputQuota', 'privateIpc', 'sourceBytesOnly',
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function frame(value) {
  const payload = Buffer.from(canonical(value));
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function ready(overrides = {}) {
  return {
    schema: 'pdf-plugin-native-attestation-v1', protocol: 1, type: 'ready',
    pluginId, pluginVersion: '1.2.3', packageHash: identity.packageHash, sourceSha256,
    supervisorPid: 501, workerPid: 502, teamIdentifier: policy.teamIdentifier,
    supervisorCdHash: policy.supervisorCdHash, workerCdHash: policy.workerCdHash,
    designatedRequirementSha256: policy.designatedRequirementSha256,
    ...Object.fromEntries(booleans.map((field) => [field, true])), ...overrides,
  };
}

test('strict ready wire attestation projects only the stable host evidence schema', () => {
  const evidence = decodeNativeReadyFrame(frame(ready()), { identity, supervisorPid: 501, policy });
  assert.deepEqual(Object.keys(evidence).sort(), [
    'appSandbox', 'cpuQuota', 'designatedRequirementSha256', 'hardMemoryQuota', 'liveCodeIdentity',
    'noNetwork', 'outputQuota', 'packageHash', 'pluginId', 'pluginVersion', 'privateIpc',
    'processQuota', 'schema', 'sourceBytesOnly', 'sourceSha256', 'staticCodeIdentity',
    'supervisorCdHash', 'supervisorPid', 'teamIdentifier', 'version', 'workerCdHash', 'workerPid',
  ]);
  assert.equal(evidence.version, 1);
  assert.equal(Object.hasOwn(evidence, 'protocol'), false);
  assert.equal(Object.hasOwn(evidence, 'type'), false);
  assert.equal(Object.isFrozen(evidence), true);
});

test('ready wire policy mismatches, extra fields, and non-hard attestations fail closed', () => {
  for (const candidate of [
    ready({ workerPid: 501 }), ready({ teamIdentifier: 'ZZZZZ99999' }),
    ready({ hardMemoryQuota: false }), { ...ready(), unexpected: true },
  ]) {
    assert.throws(() => decodeNativeReadyFrame(frame(candidate), { identity, supervisorPid: 501, policy }), {
      code: 'PLUGIN_NATIVE_ATTESTATION_FAILED', status: 503,
    });
  }
});

test('launch and two-phase envelopes bind exact source and reject malformed completion framing', () => {
  assert.equal(validateNativeLaunch(identity, source).source, source);
  assert.throws(() => validateNativeLaunch(identity, Buffer.from('changed')), {
    code: 'PLUGIN_NATIVE_LAUNCH_INVALID', status: 400,
  });
  assert.equal(encodeNativePreparation(identity, source.length).toString(),
    `{"packageHash":"${identity.packageHash}","pluginId":"${pluginId}","sourceBytes":${source.length},"sourceSha256":"${sourceSha256}","version":"1.2.3"}\n`);
  assert.deepEqual(JSON.parse(encodeNativeInvocationPhase(7)), { controlBytes: 7 });
  assert.deepEqual(unframeNativeCompletion(frame({ accepted: true })), Buffer.from('{"accepted":true}'));
  assert.throws(() => unframeNativeCompletion(Buffer.from([0, 0, 0, 2, 123])), {
    code: 'PLUGIN_NATIVE_PROTOCOL_INVALID', status: 502,
  });
});

test('release policy has no compatibility fallback for altered designated requirements', () => {
  assert.deepEqual(Object.keys(validateNativeReleasePolicy(policy)).sort(), Object.keys(policy).sort());
  const pair = validateNativeExecutablePair({
    policy,
    supervisor: { executable: '/private/release/PDFPluginSupervisor', sha256: policy.supervisorSha256 },
    worker: { executable: '/private/release/PDFPluginWorker', sha256: policy.workerSha256 },
  });
  assert.equal(pair.requirements.sha256, requirements.sha256);
  assert.throws(() => validateNativeReleasePolicy({ ...policy, designatedRequirementSha256: 'f'.repeat(64) }), TypeError);
});
