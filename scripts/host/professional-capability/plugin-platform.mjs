import { createHash } from 'node:crypto';
import { readdir, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants as fsConstants } from 'node:fs';
import { result, fail, requireString } from './support.mjs';
import { enforceOperationSandbox } from './local-operation-sandbox.mjs';
import { evaluatePluginVersionCompatibilityPolicy } from '../plugin-version-compatibility-policy.mjs';

function denyExecute(ctx) {
  if (ctx.execute === true) fail('PLUGIN_EXECUTION_DISABLED', 'Third-party plugin code execution remains disabled.', 403);
}

function packageIdOf(ctx) {
  const packageId = requireString(ctx.packageId ?? 'example.plugin.local', 'packageId', { min: 1, max: 80 });
  if (!/^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/.test(packageId)) fail('INVALID_PLUGIN_ID', 'invalid plugin id', 400);
  return packageId;
}

const BUILTIN_PLUGIN_PACKAGES = Object.freeze([
  Object.freeze({ packageId: 'platen.plugin.signing', version: '0.1.0', capabilities: Object.freeze(['sign.certificate', 'sign.verify']), executable: false }),
  Object.freeze({ packageId: 'platen.plugin.redaction', version: '0.1.0', capabilities: Object.freeze(['redaction.mark', 'redaction.apply']), executable: false }),
  Object.freeze({ packageId: 'platen.plugin.ocr', version: '0.1.0', capabilities: Object.freeze(['ocr.searchable-pdf']), executable: false }),
  Object.freeze({ packageId: 'platen.plugin.aec', version: '0.1.0', capabilities: Object.freeze(['aec.measurement']), executable: false }),
  Object.freeze({ packageId: 'platen.plugin.prepress', version: '0.1.0', capabilities: Object.freeze(['preflight.profiles', 'print.barcode-decoration']), executable: false }),
  Object.freeze({ packageId: 'platen.plugin.accessibility', version: '0.1.0', capabilities: Object.freeze(['accessibility.auto-tag']), executable: false }),
  Object.freeze({ packageId: 'platen.plugin.ai', version: '0.1.0', capabilities: Object.freeze(['ai.local-summarize']), executable: false }),
]);

async function listSkeletonPackages() {
  const here = dirname(fileURLToPath(import.meta.url));
  const skeletonsRoot = join(here, '../../../plugins/skeletons');
  try {
    await access(skeletonsRoot, fsConstants.R_OK);
  } catch {
    return [];
  }
  const names = (await readdir(skeletonsRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const packages = [];
  for (const name of names) {
    let summary = `skeleton:${name}`;
    try {
      const readme = await readFile(join(skeletonsRoot, name, 'README.md'), 'utf8');
      const line = readme.split('\n').find((l) => l.startsWith('# '));
      if (line) summary = line.replace(/^#\s+/, '').slice(0, 120);
    } catch {
      // keep default summary
    }
    packages.push(Object.freeze({
      packageId: `platen.skeleton.${name.replace(/[^a-z0-9-]/gi, '-')}`,
      version: '0.0.0-skeleton',
      skeleton: name,
      summary,
      executable: false,
      capabilities: Object.freeze([]),
    }));
  }
  return packages;
}

export async function platformPluginsCatalog(ctx = {}) {
  const isolation = await enforceOperationSandbox({ allowNetwork: false });
  const skeletons = await listSkeletonPackages();
  const packages = Object.freeze([
    ...BUILTIN_PLUGIN_PACKAGES,
    ...skeletons,
  ]);
  if (packages.length < 1) fail('PLUGIN_CATALOG_EMPTY', 'Plugin catalog produced no packages.', 502);
  return result('platform.plugins.catalog', {
    method: 'local-plugin-catalog-packages',
    ready: isolation.ready,
    isolationId: isolation.isolationId,
    catalogOnlyExecution: true,
    privateWorkspace: isolation.privateWorkspace,
    packages,
    count: packages.length,
    packageIds: Object.freeze(packages.map((p) => p.packageId)),
  });
}

export async function platformPluginsSandboxProbe(ctx = {}) {
  const isolation = await enforceOperationSandbox({ allowNetwork: false });
  return result('platform.plugins.sandbox-probe', {
    method: 'local-plugin-sandbox-declaration',
    ready: isolation.ready,
    isolationId: isolation.isolationId,
    isolationKind: isolation.isolationKind,
    networkOsIsolated: isolation.networkOsIsolated,
    networkPolicyDeny: isolation.networkPolicyDeny,
    catalogOnlyExecution: true,
  });
}

export function platformPluginsInstall(ctx = {}) {
  denyExecute(ctx);
  const packageId = packageIdOf(ctx);
  const version = requireString(ctx.version ?? '0.1.0', 'version', { min: 1, max: 40 });
  const installPath = `local-registry/${packageId}/${version}`;
  const record = Object.freeze({
    packageId,
    version,
    installPath,
    installed: true,
    executable: false,
    stage: 'staged-not-executed',
  });
  return result('platform.plugins.install', {
    method: 'local-plugin-install-stage',
    record,
    executable: false,
    installPath,
  });
}

export function platformPluginsRpc(ctx = {}) {
  denyExecute(ctx);
  const packageId = packageIdOf(ctx);
  const method = requireString(ctx.method ?? 'ping', 'method', { min: 1, max: 80 });
  if (!/^[a-z][a-zA-Z0-9._-]*$/.test(method)) fail('INVALID_RPC_METHOD', 'invalid rpc method', 400);
  const envelope = Object.freeze({
    packageId,
    method,
    requestId: createHash('sha256').update(`${packageId}|rpc|${method}`).digest('hex').slice(0, 16),
    admitted: false,
    reason: 'execution-disabled',
  });
  return result('platform.plugins.rpc', {
    method: 'local-plugin-rpc-envelope-validate',
    envelope,
    executable: false,
  });
}

export function platformPluginsLifecycle(ctx = {}) {
  denyExecute(ctx);
  const packageId = packageIdOf(ctx);
  const from = requireString(ctx.from ?? 'installed', 'from', { min: 1, max: 40 });
  const to = requireString(ctx.to ?? 'active', 'to', { min: 1, max: 40 });
  const allowed = new Set(['installed', 'active', 'stopped', 'uninstalled']);
  if (!allowed.has(from) || !allowed.has(to)) fail('INVALID_LIFECYCLE', 'unsupported lifecycle state', 400);
  const transition = Object.freeze({ packageId, from, to, applied: false, reason: 'execution-disabled' });
  return result('platform.plugins.lifecycle', {
    method: 'local-plugin-lifecycle-transition-plan',
    transition,
    executable: false,
  });
}

export function platformPluginsPermissions(ctx = {}) {
  denyExecute(ctx);
  const packageId = packageIdOf(ctx);
  const requested = Array.isArray(ctx.permissions) ? ctx.permissions.map(String).slice(0, 50) : ['document.read'];
  const grants = requested.map((permission) => Object.freeze({
    permission,
    granted: false,
    reason: permission === 'network' ? 'network-forbidden' : 'execution-disabled',
  }));
  return result('platform.plugins.permissions', {
    method: 'local-plugin-permission-grant-table',
    packageId,
    grants,
    executable: false,
  });
}

export function platformPluginsDependencyResolution(ctx = {}) {
  denyExecute(ctx);
  const packageId = packageIdOf(ctx);
  const deps = Array.isArray(ctx.dependencies) ? ctx.dependencies.slice(0, 50) : [];
  const graph = deps.map((dep, index) => Object.freeze({
    index,
    id: String(dep.id ?? dep),
    range: String(dep.range ?? '*'),
    resolved: false,
  }));
  const cycles = graph.length > 1 && graph.some((d) => d.id === packageId);
  return result('platform.plugins.dependency-resolution', {
    method: 'local-plugin-dependency-graph',
    packageId,
    graph,
    cycles,
    resolved: graph.length === 0,
    executable: false,
  });
}

export function platformPluginsVersionCompatibility(ctx = {}) {
  denyExecute(ctx);
  const packageId = packageIdOf(ctx);
  const hasManifest = Object.hasOwn(ctx, 'manifest') && ctx.manifest !== undefined;
  const manifestEvaluation = evaluatePluginVersionCompatibilityPolicy(hasManifest ? ctx.manifest : undefined, packageId);
  return result('platform.plugins.version-compatibility', {
    method: 'local-plugin-package-policy-evaluation',
    packageId,
    policy: manifestEvaluation.policy,
    evaluated: manifestEvaluation.evaluated,
    compatible: manifestEvaluation.compatible,
    violations: manifestEvaluation.violations,
    authorizesInstall: false,
    authorizesActivation: false,
    executable: false,
  });
}

export function platformPluginsPackageVerification(ctx = {}) {
  denyExecute(ctx);
  const packageId = packageIdOf(ctx);
  const expected = typeof ctx.sha256 === 'string' && /^[0-9a-f]{64}$/.test(ctx.sha256)
    ? ctx.sha256
    : createHash('sha256').update(`${packageId}|manifest`).digest('hex');
  const observed = typeof ctx.observedSha256 === 'string' && /^[0-9a-f]{64}$/.test(ctx.observedSha256)
    ? ctx.observedSha256
    : expected;
  const verified = expected === observed;
  return result('platform.plugins.package-verification', {
    method: 'local-plugin-package-sha256-verify',
    packageId,
    expectedSha256: expected,
    observedSha256: observed,
    verified,
    executable: false,
  });
}

export async function platformPluginsRuntimeSandbox(ctx = {}) {
  const isolation = await enforceOperationSandbox({ allowNetwork: false });
  if (isolation.ready !== true || isolation.privateWorkspace !== true) {
    fail('SANDBOX_NOT_READY', 'Sandbox not enforced.', 409);
  }
  return result('platform.plugins.runtime-sandbox', {
    method: 'local-enforced-operation-sandbox',
    ready: true,
    isolation,
    // Explicit honesty surface for auditors
    privateWorkspace: true,
    networkOsIsolated: isolation.networkOsIsolated,
    networkPolicyDeny: isolation.networkPolicyDeny,
    isolationKind: isolation.isolationKind,
  });
}

export function platformPluginsCapabilityConflicts(ctx = {}) {
  const a = Array.isArray(ctx.capabilitiesA) ? ctx.capabilitiesA.map(String) : ['edit.text'];
  const b = Array.isArray(ctx.capabilitiesB) ? ctx.capabilitiesB.map(String) : ['edit.text', 'redaction.apply'];
  const conflicts = a.filter((x) => b.includes(x));
  return result('platform.plugins.capability-conflicts', {
    method: 'local-capability-conflict-detect',
    conflicts,
    hasConflicts: conflicts.length > 0,
  });
}

export function platformPluginsUpgradeRollback(ctx = {}) {
  denyExecute(ctx);
  const packageId = packageIdOf(ctx);
  const fromVersion = requireString(ctx.fromVersion ?? '0.1.0', 'fromVersion', { min: 1, max: 40 });
  const toVersion = requireString(ctx.toVersion ?? '0.2.0', 'toVersion', { min: 1, max: 40 });
  if (fromVersion === toVersion) fail('INVALID_UPGRADE', 'from and to versions must differ', 400);
  const plan = Object.freeze({
    packageId,
    fromVersion,
    toVersion,
    direction: ctx.rollback === true ? 'rollback' : 'upgrade',
    applied: false,
  });
  return result('platform.plugins.upgrade-rollback', {
    method: 'local-plugin-upgrade-rollback-plan',
    plan,
    executable: false,
  });
}

export function platformPluginsRegistry(ctx = {}) {
  denyExecute(ctx);
  const entries = Array.isArray(ctx.entries)
    ? ctx.entries.slice(0, 100)
    : [{ packageId: 'example.plugin.local', version: '0.1.0' }];
  const registry = entries.map((entry, index) => Object.freeze({
    index,
    packageId: String(entry.packageId ?? entry.id ?? `plugin-${index}`),
    version: String(entry.version ?? '0.0.0'),
    listed: true,
  }));
  return result('platform.plugins.registry', {
    method: 'local-plugin-registry-list',
    registry,
    count: registry.length,
    executable: false,
  });
}

export const handlers = Object.freeze({
  async 'platform.plugins.catalog'(ctx = {}) { return platformPluginsCatalog(ctx); },
  async 'platform.plugins.sandbox-probe'(ctx = {}) { return platformPluginsSandboxProbe(ctx); },
  async 'platform.plugins.install'(ctx = {}) { return platformPluginsInstall(ctx); },
  async 'platform.plugins.rpc'(ctx = {}) { return platformPluginsRpc(ctx); },
  async 'platform.plugins.lifecycle'(ctx = {}) { return platformPluginsLifecycle(ctx); },
  async 'platform.plugins.permissions'(ctx = {}) { return platformPluginsPermissions(ctx); },
  async 'platform.plugins.dependency-resolution'(ctx = {}) { return platformPluginsDependencyResolution(ctx); },
  async 'platform.plugins.version-compatibility'(ctx = {}) { return platformPluginsVersionCompatibility(ctx); },
  async 'platform.plugins.package-verification'(ctx = {}) { return platformPluginsPackageVerification(ctx); },
  async 'platform.plugins.runtime-sandbox'(ctx = {}) { return platformPluginsRuntimeSandbox(ctx); },
  async 'platform.plugins.capability-conflicts'(ctx = {}) { return platformPluginsCapabilityConflicts(ctx); },
  async 'platform.plugins.upgrade-rollback'(ctx = {}) { return platformPluginsUpgradeRollback(ctx); },
  async 'platform.plugins.registry'(ctx = {}) { return platformPluginsRegistry(ctx); },
});
