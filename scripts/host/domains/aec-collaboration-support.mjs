import { HostError } from '../host-error.mjs';

export const MAX_POINTS = 200;
export const MAX_RECORDS = 200;

export function fail(code, message, status = 400) { throw new HostError(code, message, status); }
export function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
export function text(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_INPUT', `${name} must be a bounded non-empty string.`);
  return value.trim();
}
export function id(value, name = 'id') {
  const result = text(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) fail('INVALID_ID', `${name} must be an opaque identifier.`);
  return result;
}
export function number(value, name, { min = -1e9, max = 1e9, positive = false } = {}) {
  if (!Number.isFinite(value) || value < min || value > max || (positive && value <= 0)) fail('INVALID_NUMBER', `${name} must be a finite bounded number.`);
  return value;
}
export function list(value, name, max = MAX_RECORDS) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_LIST', `${name} must be an array with at most ${max} items.`);
  return value;
}
export function digest(value, name = 'document digest') {
  const result = text(value, name, 128);
  if (!/^[a-f0-9]{64}$/i.test(result)) fail('INVALID_DIGEST', `${name} must be a SHA-256 digest.`);
  return result.toLowerCase();
}
export function point(value) {
  if (!plain(value)) fail('INVALID_POINT', 'Points must be plain coordinate objects.');
  return { x: number(value.x, 'point.x'), y: number(value.y, 'point.y') };
}
export function points(value, min) {
  const result = list(value, 'points', MAX_POINTS).map(point);
  if (result.length < min) fail('INVALID_GEOMETRY', `At least ${min} points are required.`);
  return result;
}
export function finiteRecord(value, name) {
  if (!plain(value)) fail('INVALID_INPUT', `${name} must be a plain object.`);
  return value;
}

/** Shared local state mechanics; each domain owns its own record types. */
export class LocalWorkspaceDomain {
  #store; #clock; #ids; #auditKind;

  constructor(workspaceStateStore, { clock = () => new Date().toISOString(), idFactory = (() => { let next = 0; return (prefix) => `${prefix}-${++next}`; })() } = {}, auditKind) {
    if (!workspaceStateStore || typeof workspaceStateStore.snapshot !== 'function') throw new TypeError('A WorkspaceStateStore is required.');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions.');
    this.#store = workspaceStateStore;
    this.#clock = clock;
    this.#ids = idFactory;
    this.#auditKind = auditKind;
  }

  snapshot(documentId) { return this.#store.snapshot(documentId); }
  newId(prefix, supplied) { return id(supplied ?? this.#ids(prefix), 'record id'); }
  now() {
    const result = this.#clock();
    if (typeof result !== 'string' || Number.isNaN(Date.parse(result))) fail('INVALID_CLOCK', 'clock must return an ISO-compatible timestamp.');
    return result;
  }
  records(documentId, namespace, type) { return this.#store.snapshot(documentId).namespaces[namespace].filter((record) => record.type === type); }
  get(documentId, namespace, entityId) {
    const record = this.#store.snapshot(documentId).namespaces[namespace].find((item) => item.id === entityId);
    if (!record) fail('ENTITY_NOT_FOUND', 'The local record was not found.', 404);
    return record;
  }
  write(documentId, namespace, record, expectedRevision, action = 'create') {
    const first = action === 'update'
      ? this.#store.updateEntity(documentId, namespace, record.id, record, { expectedRevision })
      : this.#store.createEntity(documentId, namespace, record, { expectedRevision });
    return this.#store.appendAuditEvent(documentId, { kind: this.#auditKind, action, namespace, entityId: record.id, at: this.now() }, { expectedRevision: first.revision });
  }
}
