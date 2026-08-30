function unavailable(runtime) {
  runtime.fail('ADMIN_POLICY_UNAVAILABLE', 'Admin policy configuration is unavailable.');
}

export async function runAdminPolicyCommand(application, command, stdout, signal, runtime) {
  const policy = application.adminPolicy;
  if (!policy || typeof policy.list !== 'function'
    || typeof policy.setPluginPackageAdministration !== 'function') unavailable(runtime);

  runtime.cancelled(signal);
  if (command.action === 'show') {
    const state = await policy.list();
    runtime.cancelled(signal);
    await runtime.outputValue(command, stdout, Object.freeze({ action: 'show', state, localOnly: true }), signal);
    return;
  }
  if (command.action === 'set') {
    if (typeof application.adminAudit?.append !== 'function') {
      runtime.fail('ADMIN_AUDIT_UNAVAILABLE', 'Local administration audit is unavailable.');
    }
    const result = await policy.setPluginPackageAdministration({
      enabled: command.pluginPackageAdministration,
      expectedStateSha256: command.expectedStateSha256,
    });
    await application.adminAudit.append({
      eventId: `policy.set:${result.state.stateSha256}`,
      action: 'policy.set',
      subject: 'plugin-package-administration',
      outcome: 'succeeded',
    });
    runtime.cancelled(signal);
    await runtime.outputValue(command, stdout, Object.freeze({
      action: 'set',
      changed: result.changed,
      state: result.state,
      localOnly: true,
    }), signal);
    return;
  }
  runtime.fail('ADMIN_POLICY_INVALID_ACTION', 'Unsupported admin policy action.');
}
