function unavailable(runtime) {
  runtime.fail('ADMIN_AUDIT_UNAVAILABLE', 'Admin audit telemetry is unavailable.');
}

export async function runAdminAuditCommand(application, command, stdout, signal, runtime) {
  const audit = application.adminAudit;
  if (!audit || typeof audit.list !== 'function') unavailable(runtime);
  if (command.action !== 'list') {
    runtime.fail('ADMIN_AUDIT_INVALID_ACTION', 'Unsupported admin audit action.');
  }
  runtime.cancelled(signal);
  const result = await audit.list({ limit: command.limit });
  runtime.cancelled(signal);
  await runtime.outputValue(command, stdout, Object.freeze({
    action: 'list',
    audit: result,
    localOnly: true,
  }), signal);
}
