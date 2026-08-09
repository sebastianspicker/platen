import { PACKAGE_LIMITS } from '../../host/plugin-package-contract.mjs';
import { createHash } from 'node:crypto';

function unavailable(runtime) {
  runtime.fail('PLUGIN_PACKAGE_UNAVAILABLE', 'Plugin package management is unavailable.');
}

function auditUnavailable(runtime) {
  runtime.fail('ADMIN_AUDIT_UNAVAILABLE', 'Local administration audit is unavailable.');
}

function eventId(action, value) {
  return `${action}:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

async function auditMutation(application, action, subject, identity, runtime) {
  if (typeof application.adminAudit?.append !== 'function') auditUnavailable(runtime);
  await application.adminAudit.append({
    eventId: eventId(action, identity), action, subject, outcome: 'succeeded',
  });
}

export async function runPluginPackageCommand(application, command, stdout, signal, runtime) {
  const packages = application.pluginPackages;
  if (!packages || typeof packages.listPlugins !== 'function' || typeof packages.install !== 'function'
    || typeof packages.activate !== 'function' || typeof packages.rollback !== 'function'
    || typeof packages.getPlugin !== 'function') unavailable(runtime);
  runtime.cancelled(signal);
  if (command.action === 'list') {
    await runtime.outputValue(command, stdout, { action: 'list', plugins: packages.listPlugins(), localOnly: true }, signal);
    return;
  }
  if (typeof application.adminAudit?.append !== 'function') auditUnavailable(runtime);
  if (command.action === 'install') {
    const source = await runtime.readLocalInputBytes(command.packagePath, {
      minimumBytes: 1,
      maximumBytes: PACKAGE_LIMITS.maxEncodedBytes,
      extension: '.json',
      signal,
    });
    try {
      runtime.cancelled(signal);
      const result = await packages.install(source.bytes);
      await auditMutation(application, 'package.install', `${result.id}@${result.version}`, result.digest, runtime);
      await runtime.outputValue(command, stdout, { action: 'install', result, localOnly: true }, signal);
    } finally { source.bytes.fill(0); }
    return;
  }
  if (command.action === 'activate') {
    await packages.activate(command.pluginId, command.version);
    const result = packages.getPlugin(command.pluginId);
    await auditMutation(application, 'package.activate', command.pluginId, result, runtime);
    await runtime.outputValue(command, stdout, { action: 'activate', result, localOnly: true }, signal);
    return;
  }
  if (command.action === 'rollback') {
    await packages.rollback(command.pluginId);
    const result = packages.getPlugin(command.pluginId);
    await auditMutation(application, 'package.rollback', command.pluginId, result, runtime);
    await runtime.outputValue(command, stdout, { action: 'rollback', result, localOnly: true }, signal);
    return;
  }
  runtime.fail('PLUGIN_PACKAGE_INVALID_ACTION', 'Unsupported plugin package action.');
}
