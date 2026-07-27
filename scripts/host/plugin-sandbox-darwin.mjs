import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './process-runner.mjs';
import {
  DARWIN_SANDBOX_EXEC,
  availableDarwinPluginSandbox,
  unavailableDarwinPluginSandbox,
} from './plugin-sandbox-darwin-contract.mjs';
import { runDarwinCpuLimitCanary } from './plugin-sandbox-cpu-canary.mjs';
import { runDarwinNodePermissionProbe } from './plugin-sandbox-node-permission-probe.mjs';
import { runDarwinSeatbeltProbe } from './plugin-sandbox-seatbelt-probe.mjs';

export { buildDarwinPluginProbeProfile } from './plugin-sandbox-darwin-contract.mjs';

async function trustedExecutable(path, { requireRoot = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch {
    return false;
  }
  if (!metadata.isFile() || metadata.nlink !== 1n || (metadata.mode & 0o022n) !== 0n
    || (metadata.mode & 0o111n) === 0n || (requireRoot && metadata.uid !== 0n)) {
    return false;
  }
  return true;
}

export async function inspectDarwinPluginSandbox({
  runner = runProcess,
  signal,
  platform = process.platform,
  nodeExecutable = process.execPath,
  executableTrust = trustedExecutable,
} = {}) {
  if (typeof runner !== 'function') throw new TypeError('runner must be callable.');
  if (typeof executableTrust !== 'function') {
    throw new TypeError('executableTrust must be callable.');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }
  if (platform !== 'darwin') {
    return unavailableDarwinPluginSandbox('macOS is required.', platform);
  }
  let resolvedNode;
  try {
    resolvedNode = await realpath(nodeExecutable);
  } catch {
    return unavailableDarwinPluginSandbox('The fixed Node runtime is unavailable.', platform);
  }
  if (!await executableTrust(DARWIN_SANDBOX_EXEC, { requireRoot: true })
    || !await executableTrust(resolvedNode)) {
    return unavailableDarwinPluginSandbox(
      'The fixed sandbox or Node runtime did not pass local executable checks.',
      platform,
    );
  }

  const workspace = await mkdtemp(join(tmpdir(), 'pdf-plugin-sandbox-probe-'));
  try {
    await chmod(workspace, 0o700);
    const sentinelPath = join(workspace, 'sensitive.txt');
    await writeFile(sentinelPath, 'sandbox-probe-sentinel', {
      mode: 0o400,
      flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    });
    const resolvedSentinel = await realpath(sentinelPath);
    const resolvedWorkspace = await realpath(workspace);
    const seatbelt = await runDarwinSeatbeltProbe({
      runner,
      resolvedNode,
      workspace: resolvedWorkspace,
      sentinelPath: resolvedSentinel,
      signal,
      platform,
    });
    if (seatbelt.failure) return seatbelt.failure;
    const permissions = await runDarwinNodePermissionProbe({
      runner,
      resolvedNode,
      workspace: resolvedWorkspace,
      signal,
      platform,
    });
    if (permissions.failure) return permissions.failure;
    const cpuLimitCanary = await runDarwinCpuLimitCanary({
      runner,
      resolvedNode,
      workspace: resolvedWorkspace,
      signal,
    });
    return availableDarwinPluginSandbox({
      platform,
      seatbelt: seatbelt.evidence,
      permissions: permissions.evidence,
      cpuLimitCanary,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
