import { PACKAGE_LIMITS } from '../../host/plugin-package-contract.mjs';

function unavailable(runtime) {
  runtime.fail('PLUGIN_PACKAGE_UNAVAILABLE', 'Plugin package management is unavailable.');
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
      await runtime.outputValue(command, stdout, { action: 'install', result, localOnly: true }, signal);
    } finally { source.bytes.fill(0); }
    return;
  }
  if (command.action === 'activate') {
    await packages.activate(command.pluginId, command.version);
    const result = packages.getPlugin(command.pluginId);
    await runtime.outputValue(command, stdout, { action: 'activate', result, localOnly: true }, signal);
    return;
  }
  if (command.action === 'rollback') {
    await packages.rollback(command.pluginId);
    const result = packages.getPlugin(command.pluginId);
    await runtime.outputValue(command, stdout, { action: 'rollback', result, localOnly: true }, signal);
    return;
  }
  runtime.fail('PLUGIN_PACKAGE_INVALID_ACTION', 'Unsupported plugin package action.');
}
