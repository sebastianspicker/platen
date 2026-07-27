import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PACKAGED_PLUGIN_NATIVE_CANDIDATES,
  stagePackagedPluginNativeSupervisor,
} from '../scripts/host/plugin-native-supervisor-loader.mjs';
import { nativeDesignatedRequirements } from '../scripts/host/plugin-native-supervisor-contract.mjs';

const teamIdentifier = 'ABCDE12345';
const requirements = nativeDesignatedRequirements(teamIdentifier);
const policy = Object.freeze({
  schema: 'pdf-plugin-native-release-policy-v1',
  version: 1,
  teamIdentifier,
  supervisorSha256: 'a'.repeat(64),
  workerSha256: 'b'.repeat(64),
  supervisorCdHash: 'c'.repeat(40),
  workerCdHash: 'd'.repeat(40),
  designatedRequirementSha256: requirements.sha256,
});

const codeIdentity = Object.freeze({
  async verifyStaticPair() {},
  async verifyLiveSupervisor() {},
  async verifyLiveWorker() {},
});

test('packaged loader stages only the fixed app-bundle pair with exact sibling names', async () => {
  const calls = [];
  const result = await stagePackagedPluginNativeSupervisor({
    applicationRoot: '/Applications/Platen.app',
    sessionRoot: '/private/session',
    policy,
    platform: 'darwin',
    async stage(request) {
      calls.push(request);
      const supervisor = request.destinationName === 'PDFPluginSupervisor';
      return {
        available: true,
        executable: `/private/session/helpers/${request.destinationName}`,
        sha256: supervisor ? policy.supervisorSha256 : policy.workerSha256,
      };
    },
    supervisorOptions: {
      codeIdentity,
      async verifyExecutable() {},
      async spawnProcess() { throw new Error('not launched by the loader test'); },
    },
  });
  assert.equal(result.available, true);
  assert.equal(typeof result.supervisor.launch, 'function');
  assert.deepEqual(calls.map(({ candidates, destinationName }) => ({
    relativePath: candidates[0].relativePath,
    destinationName,
  })), [
    { relativePath: 'Contents/Helpers/PDFPluginSupervisor', destinationName: 'PDFPluginSupervisor' },
    { relativePath: 'Contents/Helpers/PDFPluginWorker', destinationName: 'PDFPluginWorker' },
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /[.]build|debug|swiftpm/ui);
  assert.deepEqual(PACKAGED_PLUGIN_NATIVE_CANDIDATES.supervisor, [{
    kind: 'packaged-release', relativePath: 'Contents/Helpers/PDFPluginSupervisor',
  }]);
});

test('packaged loader remains unavailable when either signed artifact is absent', async () => {
  let calls = 0;
  const result = await stagePackagedPluginNativeSupervisor({
    applicationRoot: '/Applications/Platen.app',
    sessionRoot: '/private/session',
    policy,
    platform: 'darwin',
    async stage() {
      calls += 1;
      return { available: false, reason: 'release-helper-not-built' };
    },
  });
  assert.deepEqual(result, { available: false, reason: 'release-helper-not-built' });
  assert.equal(calls, 1);
});
