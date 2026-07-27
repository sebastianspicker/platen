import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDarwinPluginProbeProfile, inspectDarwinPluginSandbox,
} from '../scripts/host/plugin-sandbox-darwin.mjs';
import { inspectPluginExecutionGate } from '../src/core/plugin-host.js';

test('probe profile denies dangerous capabilities and cannot be confused with a production allowlist', () => {
  const profile = buildDarwinPluginProbeProfile({ allowedReadPaths: ['/private/session/package'] });
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(deny process-fork\)/);
  assert.match(profile, /\(deny dynamic-code-generation\)/);
  assert.match(profile, /\(deny file-read\*/);
  assert.match(profile, /\(allow default\)/);
  assert.match(profile, /\/private\/session\/package/);
  assert.throws(() => buildDarwinPluginProbeProfile({ allowedReadPaths: ['relative'] }), TypeError);
});

test('non-macOS inspection is explicit unavailable evidence', async () => {
  const result = await inspectDarwinPluginSandbox({ platform: 'linux' });
  assert.equal(result.available, false);
  assert.equal(result.platform, 'linux');
  assert.equal(result.hard.osSandbox, false);
  assert.equal(result.bestEffort.sandboxBehaviorProbe, false);
  assert.equal(result.missing.includes('hardMemoryQuota'), true);
});

test('injected probe evidence never promotes the incomplete profile to osSandbox', async () => {
  let invocation = 0;
  const result = await inspectDarwinPluginSandbox({
    platform: 'darwin',
    executableTrust: async () => true,
    runner: async () => {
      invocation += 1;
      if (invocation === 3) throw Object.assign(new Error('cpu limit reached'), { signal: 'SIGXCPU' });
      return {
        stdout: JSON.stringify(invocation === 1 ? {
        allowedSystemRead: true,
        sensitiveReadDenied: true,
        writeDenied: true,
        networkDenied: true,
        processForkDenied: true,
        codes: { sensitiveRead: 'EPERM', write: 'EPERM', network: 'EPERM', processFork: 'EPERM' },
        } : {
          fileReadDenied: true,
          fileWriteDenied: true,
          childProcessDenied: true,
          workerThreadDenied: true,
          networkDenied: true,
        }),
        stderr: '',
        exitCode: 0,
        signal: null,
      };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.bestEffort.sandboxBehaviorProbe, true);
  assert.equal(result.bestEffort.networkCanaryDenied, true);
  assert.equal(result.bestEffort.processForkCanaryDenied, true);
  assert.equal(result.bestEffort.nodePermissionProbe, true);
  assert.equal(result.bestEffort.cpuLimitCanary, true);
  assert.deepEqual(result.gateEvidence, { sandboxBehaviorProbe: true });
  assert.equal(result.hard.noNetwork, false);
  assert.equal(result.hard.processQuota, false);
  assert.equal(result.hard.osSandbox, false);
  assert.equal(result.missing.includes('osSandbox'), true);
  assert.equal(result.missing.includes('hardMemoryQuota'), true);
  const gate = inspectPluginExecutionGate(result.gateEvidence);
  assert.equal(gate.ready, false);
  assert.equal(gate.missing.includes('noNetwork'), true);
  assert.equal(gate.missing.includes('hardMemoryQuota'), true);
});

test('installed macOS sandbox currently enforces every experimental deny probe', { skip: process.platform !== 'darwin' }, async () => {
  const result = await inspectDarwinPluginSandbox();
  assert.equal(result.available, true, result.reason ?? 'sandbox unavailable');
  assert.equal(result.bestEffort.sandboxBehaviorProbe, true, JSON.stringify(result.observed));
  assert.equal(result.observed.allowedSystemRead, true);
  assert.equal(result.observed.sensitiveReadDenied, true);
  assert.equal(result.observed.writeDenied, true);
  assert.equal(result.observed.networkDenied, true);
  assert.equal(result.observed.processForkDenied, true);
  assert.deepEqual(result.observed.nodePermissions, {
    fileReadDenied: true,
    fileWriteDenied: true,
    childProcessDenied: true,
    workerThreadDenied: true,
    networkDenied: true,
  });
  assert.equal(result.observed.cpuLimitCanary, true);
  assert.equal(result.hard.noNetwork, false);
  assert.equal(result.hard.processQuota, false);
  assert.equal(result.hard.osSandbox, false);
});
