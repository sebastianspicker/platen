import { createHash } from 'node:crypto';

export function requireWorkspace(workspace) {
  if (!workspace || typeof workspace.createEntity !== 'function' || typeof workspace.snapshot !== 'function') {
    throw new TypeError('A WorkspaceStateStore is required.');
  }
  return workspace;
}

export function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

export function boundedString(value, name, max = 10_000) {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${name} must be a bounded string.`);
  return value;
}

export function createServiceOptions({ clock = () => new Date().toISOString(), idFactory } = {}) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  let serial = 0;
  const ids = idFactory ?? ((prefix) => `${prefix}-${++serial}`);
  if (typeof ids !== 'function') throw new TypeError('idFactory must be a function.');
  return Object.freeze({ clock, idFactory: ids });
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function canonical(value) { return JSON.stringify(stable(value)); }
export function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function unsupportedCertificateOperation(operation) {
  return Object.freeze({ status: 'unsupported', code: 'CERTIFICATE_OPERATION_UNSUPPORTED', operation, certificateValid: false, message: 'Certificate, trust, revocation, LTV, and digital-ID operations are unavailable in this local prototype.' });
}
