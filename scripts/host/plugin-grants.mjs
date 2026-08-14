import { randomBytes } from 'node:crypto';
import { HostError } from './host-error.mjs';

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE_DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING_ID = /^[A-Za-z0-9_-]{16,128}$/;

export const PLUGIN_METHOD_PERMISSIONS = Object.freeze({
  'document.getMetadata': 'document.metadata',
  'document.readRange': 'document.read.bytes',
});

export const EXECUTABLE_PLUGIN_PERMISSIONS = Object.freeze([
  'document.metadata',
  'document.read.bytes',
]);

const executablePermissionSet = new Set(EXECUTABLE_PLUGIN_PERMISSIONS);

function fail(code, message, status = 403) {
  throw new HostError(code, message, status);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function assertExactKeys(value, keys, label) {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unsupported or missing fields.`);
  }
}

function assertBinding(binding) {
  assertPlainObject(binding, 'Plugin binding');
  assertExactKeys(binding, ['pluginId', 'version', 'packageHash', 'activationId'], 'Plugin binding');
  if (!PLUGIN_ID.test(binding.pluginId)) throw new TypeError('Plugin binding has an invalid plugin ID.');
  if (!SEMVER.test(binding.version)) throw new TypeError('Plugin binding has an invalid version.');
  if (!SHA256.test(binding.packageHash)) throw new TypeError('Plugin binding has an invalid package hash.');
  if (!BINDING_ID.test(binding.activationId)) throw new TypeError('Plugin binding has an invalid activation ID.');
}

function assertDocumentBinding(document) {
  assertPlainObject(document, 'Document binding');
  assertExactKeys(document, ['documentId', 'sourceDigest'], 'Document binding');
  if (!OPAQUE_DOCUMENT_ID.test(document.documentId)) throw new TypeError('Document binding has an invalid document ID.');
  if (!SHA256.test(document.sourceDigest)) throw new TypeError('Document binding has an invalid source digest.');
}

function assertOperationId(operationId) {
  if (!BINDING_ID.test(String(operationId ?? ''))) throw new TypeError('operationId must be an opaque bounded identifier.');
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function publicGrant(record) {
  return Object.freeze({
    grantId: record.grantId,
    pluginId: record.binding.pluginId,
    version: record.binding.version,
    packageHash: record.binding.packageHash,
    activationId: record.binding.activationId,
    sourceDigest: record.document.sourceDigest,
    operationId: record.operationId,
    methods: Object.freeze([...record.methods]),
    issuedAt: new Date(record.issuedAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    usageLimit: record.usageLimit,
    usageCount: record.usageCount,
    revoked: record.revoked,
  });
}

function sameBinding(left, right) {
  return left.pluginId === right.pluginId
    && left.version === right.version
    && left.packageHash === right.packageHash
    && left.activationId === right.activationId;
}

/**
 * Session-local authority for explicit plugin grants. Manifest declarations are
 * ceilings only; this store is the runtime authorization source.
 */
export class PluginGrantStore {
  #clock;
  #randomBytes;
  #audit;
  #resolveActivation;
  #resolveDocument;
  #grants = new Map();

  constructor({
    resolveActivation,
    resolveDocument,
    clock = Date.now,
    randomBytesImpl = randomBytes,
    audit = () => {},
  } = {}) {
    if (typeof resolveActivation !== 'function' || typeof resolveDocument !== 'function'
      || typeof clock !== 'function' || typeof randomBytesImpl !== 'function' || typeof audit !== 'function') {
      throw new TypeError('PluginGrantStore requires activation/document authorities and callable clock, randomBytesImpl, and audit values.');
    }
    this.#resolveActivation = resolveActivation;
    this.#resolveDocument = resolveDocument;
    this.#clock = clock;
    this.#randomBytes = randomBytesImpl;
    this.#audit = audit;
  }

  async issue({
    binding,
    documentId,
    operationId,
    permissions,
    methods,
    ttlMs = 5 * 60_000,
    usageLimit = 256,
  }) {
    assertBinding(binding);
    assertOperationId(operationId);
    positiveInteger(ttlMs, 'ttlMs', 24 * 60 * 60_000);
    positiveInteger(usageLimit, 'usageLimit', 10_000);
    if (!Array.isArray(permissions) || !Array.isArray(methods)) {
      throw new TypeError('Plugin grant permissions and methods must be arrays.');
    }
    const [activation, documentRecord] = await Promise.all([
      this.#resolveActivation(Object.freeze({ ...binding })),
      this.#resolveDocument(documentId),
    ]);
    const activationId = activation?.id ?? activation?.pluginId;
    const activationVersion = activation?.version;
    const activationHash = activation?.digest ?? activation?.packageHash;
    if (activationId !== binding.pluginId || activationVersion !== binding.version || activationHash !== binding.packageHash) {
      fail('PLUGIN_ACTIVATION_BINDING_MISMATCH', 'The verified active package does not match this grant request.');
    }
    if (!documentRecord || documentRecord.id !== documentId || !SHA256.test(documentRecord.sha256 ?? '')) {
      fail('PLUGIN_DOCUMENT_BINDING_MISMATCH', 'The verified local document does not match this grant request.', 404);
    }
    const document = { documentId, sourceDigest: documentRecord.sha256 };
    assertDocumentBinding(document);
    const declaredPermissions = activation?.manifest?.permissions?.map((permission) => permission?.name);
    if (!Array.isArray(declaredPermissions) || declaredPermissions.some((permission) => typeof permission !== 'string')) {
      fail('PLUGIN_ACTIVATION_INVALID', 'The active package has no verified permission declaration.', 500);
    }
    const declared = new Set(declaredPermissions);
    const requested = new Set(permissions);
    if (declared.size !== declaredPermissions.length || requested.size !== permissions.length || new Set(methods).size !== methods.length) {
      throw new TypeError('Plugin grant permissions and methods must not contain duplicates.');
    }
    for (const permission of requested) {
      if (!executablePermissionSet.has(permission)) fail('PLUGIN_PERMISSION_FORBIDDEN', 'The requested plugin permission is not available to executable local plugins.');
      if (!declared.has(permission)) fail('PLUGIN_PERMISSION_UNDECLARED', 'A runtime grant cannot exceed the signed manifest declaration.');
    }
    if (methods.length === 0) throw new TypeError('A plugin grant must allow at least one method.');
    for (const method of methods) {
      const permission = PLUGIN_METHOD_PERMISSIONS[method];
      if (!permission) fail('PLUGIN_METHOD_UNKNOWN', 'The requested plugin method is not brokered.', 400);
      if (!requested.has(permission)) fail('PLUGIN_PERMISSION_MISSING', 'The grant does not include the permission required by a requested method.');
    }

    const issuedAt = this.#clock();
    const grantId = `pg_${this.#randomBytes(32).toString('hex')}`;
    const record = {
      grantId,
      binding: Object.freeze({ ...binding }),
      document: Object.freeze({ ...document }),
      operationId,
      permissions: Object.freeze([...requested]),
      methods: Object.freeze([...methods]),
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      usageLimit,
      usageCount: 0,
      revoked: false,
      revokedReason: null,
    };
    this.#grants.set(grantId, record);
    this.#audit({
      type: 'plugin.grant.issued', grantId, pluginId: binding.pluginId, version: binding.version,
      packageHash: binding.packageHash, activationId: binding.activationId,
      sourceDigest: document.sourceDigest, operationId, methods: [...methods], expiresAt: record.expiresAt,
    });
    return publicGrant(record);
  }

  authorize(grantId, { binding, document, operationId, method }, { consume = true } = {}) {
    const record = this.#grants.get(String(grantId ?? ''));
    if (!record) fail('PLUGIN_GRANT_NOT_FOUND', 'The plugin grant does not exist or is no longer available.', 404);
    assertBinding(binding);
    assertDocumentBinding(document);
    assertOperationId(operationId);
    if (!Object.hasOwn(PLUGIN_METHOD_PERMISSIONS, method)) fail('PLUGIN_METHOD_UNKNOWN', 'The requested plugin method is not brokered.', 400);
    if (record.revoked) fail('PLUGIN_GRANT_REVOKED', 'The plugin grant has been revoked.');
    if (this.#clock() >= record.expiresAt) fail('PLUGIN_GRANT_EXPIRED', 'The plugin grant has expired.');
    if (!sameBinding(record.binding, binding)
      || record.document.documentId !== document.documentId
      || record.document.sourceDigest !== document.sourceDigest
      || record.operationId !== operationId) {
      fail('PLUGIN_GRANT_BINDING_MISMATCH', 'The plugin grant does not authorize this activation, document, or operation.');
    }
    if (!record.methods.includes(method)) fail('PLUGIN_METHOD_DENIED', 'The plugin grant does not authorize this method.');
    if (consume && record.usageCount >= record.usageLimit) fail('PLUGIN_GRANT_CONSUMED', 'The plugin grant usage limit has been reached.');
    if (consume) record.usageCount += 1;
    return publicGrant(record);
  }

  revoke(grantId, reason = 'user-revoked') {
    const record = this.#grants.get(String(grantId ?? ''));
    if (!record) return false;
    if (record.revoked) return false;
    record.revoked = true;
    record.revokedReason = String(reason).slice(0, 120);
    this.#audit({
      type: 'plugin.grant.revoked', grantId: record.grantId, pluginId: record.binding.pluginId,
      packageHash: record.binding.packageHash, activationId: record.binding.activationId,
      sourceDigest: record.document.sourceDigest, reason: record.revokedReason,
    });
    return true;
  }

  revokeActivation(activationId, reason = 'activation-ended') {
    let count = 0;
    for (const record of this.#grants.values()) {
      if (record.binding.activationId === activationId && this.revoke(record.grantId, reason)) count += 1;
    }
    return count;
  }

  revokeDocument(documentId, reason = 'document-closed') {
    if (!OPAQUE_DOCUMENT_ID.test(String(documentId ?? ''))) throw new TypeError('Invalid document ID.');
    let count = 0;
    for (const record of this.#grants.values()) {
      if (record.document.documentId === documentId && this.revoke(record.grantId, reason)) count += 1;
    }
    return count;
  }

  inspect(grantId) {
    const record = this.#grants.get(String(grantId ?? ''));
    if (!record) fail('PLUGIN_GRANT_NOT_FOUND', 'The plugin grant was not found.', 404);
    return publicGrant(record);
  }
}

export { assertBinding as assertPluginBinding, assertOperationId as assertPluginOperationId };
