export async function runPluginAllowlistCommand(application, command, stdout, signal, runtime) {
  const { trustedPublishers } = application;
  if (!trustedPublishers
    || typeof trustedPublishers.list !== 'function'
    || typeof trustedPublishers.enroll !== 'function'
    || typeof trustedPublishers.revoke !== 'function'
    || typeof trustedPublishers.unrevoke !== 'function'
    || typeof trustedPublishers.remove !== 'function') {
    runtime.fail('PLUGIN_ALLOWLIST_UNAVAILABLE', 'Plugin allowlist is unavailable.');
  }
  if (signal) runtime.cancelled(signal);
  if (command.action === 'list') {
    const state = await trustedPublishers.list();
    await runtime.outputValue(command, stdout, state, signal);
    return;
  }
  const publicKey = command.publicKey
    ? (await runtime.readLocalInputBytes(command.publicKey, {
      minimumBytes: 1, maximumBytes: 65536, extension: '.pem', signal,
    })).bytes.toString('utf8')
    : null;
  if (command.action === 'enroll') {
    const entry = await trustedPublishers.enroll({
      publisherId: command.publisherId,
      keyId: command.keyId,
      publicKey,
      pluginIds: [...command.pluginIds],
    });
    const state = await trustedPublishers.list();
    await runtime.outputValue(command, stdout, Object.freeze({
      action: 'enroll',
      entry,
      state,
      localOnly: true,
    }), signal);
    return;
  }
  if (command.action === 'revoke') {
    const entry = await trustedPublishers.revoke({
      publisherId: command.publisherId,
      keyId: command.keyId,
    });
    const state = await trustedPublishers.list();
    await runtime.outputValue(command, stdout, Object.freeze({ action: 'revoke', entry, localOnly: true, state }), signal);
    return;
  }
  if (command.action === 'unrevoke') {
    const entry = await trustedPublishers.unrevoke({
      publisherId: command.publisherId,
      keyId: command.keyId,
    });
    const state = await trustedPublishers.list();
    await runtime.outputValue(command, stdout, Object.freeze({ action: 'unrevoke', entry, localOnly: true, state }), signal);
    return;
  }
  if (command.action === 'remove') {
    const removed = await trustedPublishers.remove({
      publisherId: command.publisherId,
      keyId: command.keyId,
      expectedFingerprint: command.expectedFingerprint,
    });
    const state = await trustedPublishers.list();
    await runtime.outputValue(command, stdout, Object.freeze({
      action: 'remove',
      entry: removed,
      localOnly: true,
      state,
    }), signal);
    return;
  }
  runtime.fail('PLUGIN_ALLOWLIST_INVALID_ACTION', 'Unsupported plugin allowlist action.');
}
