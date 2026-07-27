const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;

function exact(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function optionsValid(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  return exact(options, options.signal === undefined ? [] : ['signal'])
    && (options.signal === undefined || options.signal instanceof AbortSignal);
}

function pluginSummary(value) {
  if (!exact(value, ['id', 'activeVersion', 'previousVersion', 'versions'])
    || !PLUGIN_ID.test(value.id)
    || (value.activeVersion !== null && !SEMVER.test(value.activeVersion))
    || (value.previousVersion !== null && !SEMVER.test(value.previousVersion))
    || !Array.isArray(value.versions) || value.versions.length > 64) return false;
  return value.versions.every((entry) => exact(entry, ['version', 'digest'])
    && SEMVER.test(entry.version) && SHA256.test(entry.digest));
}

function lifecycle(body, action) {
  if (!exact(body, ['action', 'result', 'localOnly']) || body.action !== action
    || body.localOnly !== true) throw new TypeError('Plugin package lifecycle response is invalid.');
  if (action === 'install') {
    if (!exact(body.result, ['id', 'version', 'digest']) || !PLUGIN_ID.test(body.result.id)
      || !SEMVER.test(body.result.version) || !SHA256.test(body.result.digest)) {
      throw new TypeError('Plugin package lifecycle response is invalid.');
    }
  } else if (!exact(body.result, ['id', 'activeVersion', 'previousVersion', 'versions'])
    || !pluginSummary(body.result)) {
    throw new TypeError('Plugin package lifecycle response is invalid.');
  }
  return Object.freeze(body.result);
}

function list(body) {
  if (!exact(body, ['plugins']) || !Array.isArray(body.plugins) || body.plugins.length > 64
    || body.plugins.some((plugin) => !pluginSummary(plugin))) {
    throw new TypeError('Plugin package listing response is invalid.');
  }
  return Object.freeze(body.plugins);
}

export function createPluginPackageEndpoints({ request }) {
  if (typeof request !== 'function') throw new TypeError('Plugin package endpoints require request transport.');
  return Object.freeze({
    listPluginPackages(options = {}) {
      if (!optionsValid(options)) throw new TypeError('Plugin package options are invalid.');
      return request('/api/plugin-packages', { method: 'GET', signal: options.signal })
        .then((response) => response.json()).then(list);
    },
    installPluginPackage(bytes, options = {}) {
      if (!optionsValid(options) || (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer))
        || bytes.byteLength < 1 || bytes.byteLength > MAX_PACKAGE_BYTES) {
        throw new TypeError('Plugin package input is invalid.');
      }
      return request('/api/plugin-packages/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        signal: options.signal,
      }).then((response) => response.json()).then((body) => lifecycle(body, 'install'));
    },
    activatePluginPackage(id, version, options = {}) {
      if (!PLUGIN_ID.test(id ?? '') || !SEMVER.test(version ?? '') || !optionsValid(options)) {
        throw new TypeError('Plugin activation options are invalid.');
      }
      return request(`/api/plugin-packages/${encodeURIComponent(id)}/activate?version=${encodeURIComponent(version)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: options.signal,
      }).then((response) => response.json()).then((body) => lifecycle(body, 'activate'));
    },
    rollbackPluginPackage(id, options = {}) {
      if (!PLUGIN_ID.test(id ?? '') || !optionsValid(options)) throw new TypeError('Plugin rollback options are invalid.');
      return request(`/api/plugin-packages/${encodeURIComponent(id)}/rollback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: options.signal,
      }).then((response) => response.json()).then((body) => lifecycle(body, 'rollback'));
    },
  });
}

export { pluginSummary };
