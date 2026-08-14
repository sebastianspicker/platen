import { validatePluginSandboxStatus } from './plugin-sandbox-status-contract.js';

function validOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const keys = Object.keys(options);
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'signal')) return false;
  return options.signal === undefined
    || (typeof globalThis.AbortSignal === 'function'
      && options.signal instanceof globalThis.AbortSignal);
}

/** Host-platform diagnostics that never accept plugin bytes or execution evidence. */
export function createPlatformEndpoints({ json }) {
  return Object.freeze({
    runPluginSandboxProbe(options = {}) {
      if (!validOptions(options)) throw new TypeError('Plugin sandbox probe options are invalid.');
      return json('/api/plugin-sandbox-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: options.signal,
      }).then(validatePluginSandboxStatus);
    },
    runPluginAllowlist(request, options = {}) {
      if (!validOptions(options)) throw new TypeError('Plugin allowlist options are invalid.');
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new TypeError('Plugin allowlist request is invalid.');
      }
      return json('/api/plugin-allowlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: options.signal,
      });
    },
  });
}
