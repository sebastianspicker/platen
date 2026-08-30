const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SUPPORT = new Set(['unsupported', 'unavailable-on-platform']);
function exact(value, keys) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function dataArray(value, min = 0, max = 64) { if (!Array.isArray(value) || value.length < min || value.length > max || Object.getOwnPropertySymbols(value).length) return false; const descriptors = Object.getOwnPropertyDescriptors(value); return !descriptors.length?.enumerable && !descriptors.length?.get && !descriptors.length?.set && Object.keys(value).length === value.length && Object.keys(descriptors).filter((key) => key !== 'length').every((key) => descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')); }
function bounded(value) { return typeof value === 'string' && value === value.normalize('NFC') && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value); }
function evidence(value) { return exact(value, ['api', 'discoveryAttempted', 'liveVerification', 'scanSupport']) && value.api === 'ImageCaptureCore' && typeof value.discoveryAttempted === 'boolean' && value.liveVerification === false && SUPPORT.has(value.scanSupport); }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }
function validate(body) {
  const shape = body?.ok === true ? (exact(body, ['version', 'ok', 'result']) || exact(body, ['version', 'ok', 'result', 'error'])) : (exact(body, ['version', 'ok', 'error']) || exact(body, ['version', 'ok', 'result', 'error']));
  if (!shape || body.version !== 1 || typeof body.ok !== 'boolean') throw new TypeError('Scanner discovery response is invalid.');
  if (body.ok) {
    if ((Object.hasOwn(body, 'error') && body.error !== null) || !exact(body.result, ['devices', 'evidence']) || !dataArray(body.result.devices) || !evidence(body.result.evidence)) throw new TypeError('Scanner discovery response is invalid.');
    const ids = new Set(); for (const device of body.result.devices) if (!exact(device, ['id', 'name', 'kind', 'capabilities']) || !ID.test(device.id) || ids.has(device.id) || !bounded(device.name) || device.kind !== 'scanner' || !dataArray(device.capabilities, 1, 1) || device.capabilities[0] !== 'image-acquisition-discovery') throw new TypeError('Scanner discovery response is invalid.'); else ids.add(device.id);
  } else if ((Object.hasOwn(body, 'result') && body.result !== null) || !exact(body.error, ['code', 'reason', 'evidence']) || !ID.test(body.error.code) || !bounded(body.error.reason) || !evidence(body.error.evidence)) throw new TypeError('Scanner discovery response is invalid.');
  return freeze(body);
}
export function createScannerDiscoveryEndpoints({ json }) {
  const discoverScanners = (options = {}) => {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some((key) => key !== 'signal') || Object.values(Object.getOwnPropertyDescriptors(options)).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Scanner discovery options are invalid.');
      return json('/api/scanners/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}), signal: options.signal }).then(validate);
    };
  return Object.freeze({ discoverScanners });
}
export { validate as validateScannerDiscoveryResult };
