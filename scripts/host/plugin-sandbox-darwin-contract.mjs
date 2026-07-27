import { isAbsolute } from 'node:path';
import { HostError } from './host-error.mjs';

export const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const SENSITIVE_READ_ROOTS = Object.freeze([
  '/Users', '/private', '/Volumes', '/Network', '/Applications', '/Library',
]);
const SEATBELT_RESULT_FIELDS = Object.freeze([
  'allowedSystemRead', 'sensitiveReadDenied', 'writeDenied',
  'networkDenied', 'processForkDenied', 'codes',
]);
export const NODE_PERMISSION_FIELDS = Object.freeze([
  'fileReadDenied', 'fileWriteDenied', 'childProcessDenied',
  'workerThreadDenied', 'networkDenied',
]);

function seatbeltString(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')
    || value.includes('\n') || value.includes('\r')) {
    throw new TypeError('Seatbelt paths must be absolute strings without control characters.');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Experimental behavior-probe policy only. It denies the highest-risk local
 * capabilities while allowing system/runtime reads. Because it starts from
 * `allow default`, it is not a production filesystem allowlist and must never
 * satisfy the complete `osSandbox` execution gate.
 */
export function buildDarwinPluginProbeProfile({ allowedReadPaths = [] } = {}) {
  if (!Array.isArray(allowedReadPaths) || allowedReadPaths.length > 16) {
    throw new TypeError('allowedReadPaths must be an array of at most 16 paths.');
  }
  const roots = SENSITIVE_READ_ROOTS
    .map((path) => `(subpath ${seatbeltString(path)})`)
    .join(' ');
  const exceptions = allowedReadPaths.length === 0
    ? ''
    : `\n(allow file-read* ${allowedReadPaths
      .map((path) => `(subpath ${seatbeltString(path)})`).join(' ')})`;
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny process-fork)
(deny dynamic-code-generation)
(deny file-read* ${roots})${exceptions}`;
}

export function darwinSeatbeltProbeSource(sentinelPath, writePath) {
  return `
const fs = require('node:fs');
const net = require('node:net');
const child = require('node:child_process');
const denied = (work) => { try { work(); return { denied: false, code: null }; } catch (error) { return { denied: ['EPERM', 'EACCES'].includes(error?.code), code: error?.code ?? null }; } };
const system = (() => { try { fs.readFileSync('/usr/bin/true'); return true; } catch { return false; } })();
const sensitive = denied(() => fs.readFileSync(${JSON.stringify(sentinelPath)}));
const write = denied(() => fs.writeFileSync(${JSON.stringify(writePath)}, 'forbidden'));
const forked = (() => { const result = child.spawnSync('/usr/bin/true'); return { denied: ['EPERM', 'EACCES'].includes(result.error?.code), code: result.error?.code ?? null }; })();
const socket = net.createConnection({ host: '127.0.0.1', port: 9 });
socket.once('connect', () => { socket.destroy(); finish(false, 'CONNECTED'); });
socket.once('error', (error) => finish(['EPERM', 'EACCES'].includes(error?.code), error?.code ?? null));
const timer = setTimeout(() => { socket.destroy(); finish(false, 'TIMEOUT'); }, 1000);
function finish(networkDenied, networkCode) {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({
    allowedSystemRead: system,
    sensitiveReadDenied: sensitive.denied,
    writeDenied: write.denied,
    networkDenied,
    processForkDenied: forked.denied,
    codes: { sensitiveRead: sensitive.code, write: write.code, network: networkCode, processFork: forked.code },
  }));
}
`;
}

export function darwinNodePermissionProbeSource() {
  return `
import fs from 'node:fs';
import net from 'node:net';
import childProcess from 'node:child_process';
import { Worker } from 'node:worker_threads';
const denied = (work, permission) => { try { work(); return false; } catch (error) { return error?.code === 'ERR_ACCESS_DENIED' && error?.permission === permission; } };
const result = {
  fileReadDenied: denied(() => fs.readFileSync('/private/etc/hosts'), 'FileSystemRead'),
  fileWriteDenied: denied(() => fs.writeFileSync('/dev/null', 'x'), 'FileSystemWrite'),
  childProcessDenied: denied(() => childProcess.spawnSync('/usr/bin/true'), 'ChildProcess'),
  workerThreadDenied: denied(() => new Worker('', { eval: true }), 'WorkerThreads'),
  networkDenied: false,
};
const socket = net.createConnection({ host: '127.0.0.1', port: 9 });
socket.once('connect', () => { socket.destroy(); finish(false); });
socket.once('error', (error) => finish(error?.code === 'ERR_ACCESS_DENIED'));
const timer = setTimeout(() => { socket.destroy(); finish(false); }, 1000);
function finish(networkDenied) {
  clearTimeout(timer);
  result.networkDenied = networkDenied;
  process.stdout.write(JSON.stringify(result));
}
`;
}

function exactSeatbeltProbeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== SEATBELT_RESULT_FIELDS.length
    || Object.keys(value).some((key) => !SEATBELT_RESULT_FIELDS.includes(key))
    || SEATBELT_RESULT_FIELDS.slice(0, -1).some((key) => typeof value[key] !== 'boolean')
    || !value.codes || typeof value.codes !== 'object' || Array.isArray(value.codes)
    || Object.keys(value.codes).length !== 4
    || !['sensitiveRead', 'write', 'network', 'processFork']
      .every((key) => Object.hasOwn(value.codes, key))) {
    throw new HostError(
      'PLUGIN_SANDBOX_PROBE_INVALID',
      'The macOS sandbox probe returned invalid evidence.',
      500,
    );
  }
  return value;
}

function exactNodePermissionResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== NODE_PERMISSION_FIELDS.length
    || Object.keys(value).some((key) => !NODE_PERMISSION_FIELDS.includes(key))
    || NODE_PERMISSION_FIELDS.some((key) => typeof value[key] !== 'boolean')) {
    throw new HostError(
      'PLUGIN_PERMISSION_PROBE_INVALID',
      'The Node permission probe returned invalid evidence.',
      500,
    );
  }
  return value;
}

export function parseDarwinSeatbeltProbeOutput(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new HostError(
      'PLUGIN_SANDBOX_PROBE_INVALID',
      'The macOS sandbox probe did not return strict JSON.',
      500,
    );
  }
  return exactSeatbeltProbeResult(value);
}

export function parseDarwinNodePermissionProbeOutput(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new HostError(
      'PLUGIN_PERMISSION_PROBE_INVALID',
      'The Node permission probe did not return strict JSON.',
      500,
    );
  }
  return exactNodePermissionResult(value);
}

export function darwinProbeEnvironment(workspace) {
  return {
    HOME: workspace,
    TMPDIR: workspace,
    XDG_CACHE_HOME: workspace,
    XDG_CONFIG_HOME: workspace,
    XDG_RUNTIME_DIR: workspace,
  };
}

export function unavailableDarwinPluginSandbox(reason, platform = process.platform) {
  return Object.freeze({
    available: false,
    platform,
    profileKind: 'experimental-deny-sensitive-roots-v1',
    hard: Object.freeze({
      osSandbox: false,
      noNetwork: false,
      processQuota: false,
      cpuQuota: false,
      hardMemoryQuota: false,
    }),
    bestEffort: Object.freeze({
      sandboxBehaviorProbe: false,
      filesystemWriteDenied: false,
      sensitiveFilesystemReadDenied: false,
      networkCanaryDenied: false,
      processForkCanaryDenied: false,
      nodePermissionProbe: false,
      cpuLimitCanary: false,
      jitless: false,
    }),
    gateEvidence: Object.freeze({ sandboxBehaviorProbe: false }),
    missing: Object.freeze([
      'osSandbox', 'noNetwork', 'processQuota', 'cpuQuota', 'hardMemoryQuota',
    ]),
    reason,
    limitations: Object.freeze([
      'No plugin code was executed.',
      'The probe profile is not a production filesystem allowlist.',
      'sandbox-exec is a deprecated platform interface.',
    ]),
  });
}

export function availableDarwinPluginSandbox({
  platform,
  seatbelt,
  permissions,
  cpuLimitCanary,
}) {
  const seatbeltPassed = seatbelt.allowedSystemRead && seatbelt.sensitiveReadDenied
    && seatbelt.writeDenied && seatbelt.networkDenied && seatbelt.processForkDenied;
  const permissionsPassed = NODE_PERMISSION_FIELDS.every((key) => permissions[key]);
  const behaviorPassed = seatbeltPassed && permissionsPassed && cpuLimitCanary;
  return Object.freeze({
    available: true,
    platform,
    profileKind: 'experimental-deny-sensitive-roots-v1',
    hard: Object.freeze({
      osSandbox: false,
      noNetwork: false,
      processQuota: false,
      cpuQuota: false,
      hardMemoryQuota: false,
    }),
    bestEffort: Object.freeze({
      sandboxBehaviorProbe: behaviorPassed,
      filesystemWriteDenied: seatbelt.writeDenied,
      sensitiveFilesystemReadDenied: seatbelt.sensitiveReadDenied,
      networkCanaryDenied: seatbelt.networkDenied,
      processForkCanaryDenied: seatbelt.processForkDenied,
      nodePermissionProbe: permissionsPassed,
      cpuLimitCanary,
      jitless: true,
    }),
    gateEvidence: Object.freeze({ sandboxBehaviorProbe: behaviorPassed }),
    missing: Object.freeze([
      'osSandbox', 'noNetwork', 'processQuota', 'cpuQuota', 'hardMemoryQuota',
    ]),
    observed: Object.freeze({
      ...seatbelt,
      codes: Object.freeze({ ...seatbelt.codes }),
      nodePermissions: Object.freeze({ ...permissions }),
      cpuLimitCanary,
    }),
    reason: behaviorPassed ? null : 'One or more deny probes did not behave as required.',
    limitations: Object.freeze([
      'No plugin code was executed.',
      'The allow-default probe profile is not a production filesystem allowlist and cannot satisfy osSandbox.',
      'Fixed network and process canaries do not prove general no-network or per-activation process containment.',
      'The Node permission canaries are defense-in-depth observations, not a malicious-code sandbox.',
      'The CPU canary observes inherited RLIMIT_CPU behavior; it is not aggregate descendant accounting.',
      'Hard memory containment was not tested and is unavailable.',
      'sandbox-exec is a deprecated platform interface and requires a startup probe after OS changes.',
    ]),
  });
}
