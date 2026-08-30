async function loadOptionalHostCapabilities(context, host, engines) {
  const { state, client } = context;
  if (host.workflowDomainsReady) {
    try {
      state.domainOperations = await client.domainOperations();
    } catch {
      state.domainOperations = null;
    }
  }
  if (engines.some(({ name, available }) => name === 'tesseract' && available)) {
    try {
      state.ocrLanguages = await client.ocrLanguages();
      if (!state.ocrLanguages.includes(state.ocrLanguage)) {
        state.ocrLanguage = state.ocrLanguages[0] ?? 'eng';
      }
    } catch {
      state.ocrLanguages = [];
    }
  }
}

function bootstrapHost(context) {
  const { state, client, render } = context;
  return client.bootstrap()
    .then(async ({ host, engines }) => {
      state.host = { status: 'ready', ...host, engines };
      await loadOptionalHostCapabilities(context, host, engines);
      render();
      return state.host;
    })
    .catch((error) => {
      state.host = { status: 'unavailable', engines: [], message: error.message };
      render();
      throw error;
    });
}

export function createHostConnectionController({ state, client, render }) {
  const context = { state, client, render, hostPromise: null };
  async function connectLocalHost() {
    if (state.host.status === 'ready') return state.host;
    if (context.hostPromise) return context.hostPromise;
    state.host = { status: 'connecting', engines: [] };
    context.hostPromise = bootstrapHost(context).finally(() => {
      context.hostPromise = null;
    });
    return context.hostPromise;
  }
  return Object.freeze({ connectLocalHost });
}
