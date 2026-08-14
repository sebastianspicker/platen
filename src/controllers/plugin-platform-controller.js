export function createPluginPlatformController({
  state,
  client,
  connectLocalHost,
  render,
  announce,
  showError,
}) {
  if (!state || !client || typeof client.runPluginSandboxProbe !== 'function'
    || [connectLocalHost, render, announce, showError]
    .every((callback) => typeof callback === 'function') === false) {
    throw new TypeError('Plugin platform controller requires state, client, and callbacks.');
  }

  async function inspectSandbox() {
    if (state.probeResult === 'checking') return null;
    state.probeResult = 'checking';
    state.pluginSandboxStatus = null;
    state.error = null;
    render();
    try {
      await connectLocalHost();
      const status = await client.runPluginSandboxProbe();
      state.pluginSandboxStatus = status;
      state.probeResult = 'blocked';
      announce(status.reasonCode === 'BEST_EFFORT_CANARIES_PASSED'
        ? 'Diagnostic containment canaries passed, but every production plugin hard gate remains closed.'
        : status.reasonCode === 'PROBE_UNAVAILABLE'
          ? 'The diagnostic containment probe is unavailable; every production plugin hard gate remains closed.'
          : 'Plugin containment evidence is incomplete; every production plugin hard gate remains closed.');
      render();
      return status;
    } catch (error) {
      state.pluginSandboxStatus = null;
      state.probeResult = 'failed';
      showError(error);
      return null;
    }
  }

  return Object.freeze({ inspectSandbox });
}
