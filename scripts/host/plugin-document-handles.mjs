import { randomBytes } from 'node:crypto';
import { HostError } from './host-error.mjs';
import { readBoundedVerifiedPluginSource } from './plugin-document-handle-source.mjs';
import { assertPluginBinding, assertPluginOperationId } from './plugin-grants.mjs';

const HANDLE = /^pdfh_[0-9a-f]{64}$/;

function fail(code, message, status = 403) {
  throw new HostError(code, message, status);
}

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
}

function publicHandle(record) {
  return Object.freeze({
    handle: record.handle,
    sourceDigest: record.sourceDigest,
    methods: Object.freeze([...record.methods]),
    issuedAt: new Date(record.issuedAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    usageLimit: record.usageLimit,
    byteLimit: record.byteLimit,
  });
}

function safeMetadata(document) {
  return Object.freeze({
    displayName: document.displayName,
    mediaType: document.mediaType,
    size: document.size,
    sha256: document.sha256,
    origin: document.origin,
    createdAt: document.createdAt,
  });
}

/** Host-only opaque capabilities. Neither handles nor results reveal a path or document UUID. */
export class PluginDocumentHandleStore {
  #documents;
  #grants;
  #clock;
  #randomBytes;
  #audit;
  #maxReadBytes;
  #handles = new Map();

  constructor({
    documents,
    grants,
    clock = Date.now,
    randomBytesImpl = randomBytes,
    audit = () => {},
    maxReadBytes = 1024 * 1024,
  }) {
    if (!documents || typeof documents.getDocument !== 'function' || typeof documents.verifySource !== 'function'
      || typeof documents.getSourcePath !== 'function') {
      throw new TypeError('PluginDocumentHandleStore requires a DocumentStore-compatible object.');
    }
    if (!grants || typeof grants.authorize !== 'function') throw new TypeError('PluginDocumentHandleStore requires a PluginGrantStore.');
    if (typeof clock !== 'function' || typeof randomBytesImpl !== 'function' || typeof audit !== 'function') {
      throw new TypeError('PluginDocumentHandleStore requires callable clock, randomBytesImpl, and audit values.');
    }
    positiveInteger(maxReadBytes, 'maxReadBytes', 16 * 1024 * 1024);
    this.#documents = documents;
    this.#grants = grants;
    this.#clock = clock;
    this.#randomBytes = randomBytesImpl;
    this.#audit = audit;
    this.#maxReadBytes = maxReadBytes;
  }

  issue({
    grantId,
    binding,
    documentId,
    operationId,
    methods,
    ttlMs = 5 * 60_000,
    usageLimit = 256,
    byteLimit = 32 * 1024 * 1024,
  }) {
    assertPluginBinding(binding);
    assertPluginOperationId(operationId);
    positiveInteger(ttlMs, 'ttlMs', 24 * 60 * 60_000);
    positiveInteger(usageLimit, 'usageLimit', 10_000);
    positiveInteger(byteLimit, 'byteLimit', 512 * 1024 * 1024);
    if (!Array.isArray(methods) || methods.length === 0 || new Set(methods).size !== methods.length) {
      throw new TypeError('Document handle methods must be a non-empty unique array.');
    }
    const document = this.#documents.getDocument(documentId);
    const documentBinding = { documentId, sourceDigest: document.sha256 };
    for (const method of methods) {
      this.#grants.authorize(grantId, { binding, document: documentBinding, operationId, method }, { consume: false });
    }
    const issuedAt = this.#clock();
    const handle = `pdfh_${this.#randomBytes(32).toString('hex')}`;
    const record = {
      handle,
      grantId,
      binding: Object.freeze({ ...binding }),
      documentId,
      sourceDigest: document.sha256,
      operationId,
      methods: Object.freeze([...methods]),
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      usageLimit,
      usageCount: 0,
      byteLimit,
      bytesRead: 0,
      revoked: false,
    };
    this.#handles.set(handle, record);
    this.#audit({
      type: 'plugin.handle.issued', handleFingerprint: handle.slice(-16),
      pluginId: binding.pluginId, packageHash: binding.packageHash,
      activationId: binding.activationId, sourceDigest: document.sha256,
      operationId, methods: [...methods], expiresAt: record.expiresAt,
    });
    return publicHandle(record);
  }

  async getMetadata(handle, context) {
    const record = await this.#authorize(handle, context, 'document.getMetadata');
    this.#assertStillAuthorized(record, context, 'document.getMetadata');
    return safeMetadata(this.#documents.getDocument(record.documentId));
  }

  async readRange(handle, { offset, length }, context) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative safe integer.');
    positiveInteger(length, 'length', this.#maxReadBytes);
    const record = await this.#authorize(handle, context, 'document.readRange', { consume: false });
    const document = this.#documents.getDocument(record.documentId);
    if (offset > document.size || length > document.size - offset) {
      fail('PLUGIN_RANGE_INVALID', 'The requested document range is outside the immutable source.', 416);
    }
    if (record.usageCount >= record.usageLimit) fail('PLUGIN_HANDLE_CONSUMED', 'The document handle usage limit has been reached.');
    if (record.bytesRead + length > record.byteLimit) fail('PLUGIN_HANDLE_BYTE_QUOTA', 'The document handle byte quota has been reached.', 429);
    record.usageCount += 1;
    record.bytesRead += length;
    this.#grants.authorize(record.grantId, this.#grantContext(record, context, 'document.readRange'));
    try {
      const result = await readBoundedVerifiedPluginSource({
        path: this.#documents.getSourcePath(record.documentId),
        expectedSize: document.size,
        expectedSha256: record.sourceDigest,
        offset,
        length,
      });
      await this.#documents.verifySource(record.documentId);
      this.#assertStillAuthorized(record, context, 'document.readRange');
      return result;
    } catch (error) {
      if (error instanceof HostError) throw error;
      fail('PLUGIN_SOURCE_CHANGED', 'The immutable source changed or is unsafe for a bounded read.', 409);
    }
  }

  revoke(handle, reason = 'user-revoked') {
    const record = this.#handles.get(String(handle ?? ''));
    if (!record || record.revoked) return false;
    record.revoked = true;
    this.#audit({
      type: 'plugin.handle.revoked', handleFingerprint: record.handle.slice(-16),
      pluginId: record.binding.pluginId, packageHash: record.binding.packageHash,
      activationId: record.binding.activationId, sourceDigest: record.sourceDigest,
      reason: String(reason).slice(0, 120),
    });
    return true;
  }

  revokeActivation(activationId, reason = 'activation-ended') {
    let count = 0;
    for (const record of this.#handles.values()) {
      if (record.binding.activationId === activationId && this.revoke(record.handle, reason)) count += 1;
    }
    return count;
  }

  revokeDocument(documentId, reason = 'document-closed') {
    let count = 0;
    for (const record of this.#handles.values()) {
      if (record.documentId === documentId && this.revoke(record.handle, reason)) count += 1;
    }
    return count;
  }

  async #authorize(handle, context, method, { consume = true } = {}) {
    if (!HANDLE.test(String(handle ?? ''))) fail('PLUGIN_HANDLE_NOT_FOUND', 'The document handle is invalid or unavailable.', 404);
    const record = this.#handles.get(handle);
    if (!record) fail('PLUGIN_HANDLE_NOT_FOUND', 'The document handle is invalid or unavailable.', 404);
    assertPluginBinding(context?.binding);
    assertPluginOperationId(context?.operationId);
    if (context?.signal !== undefined && !(context.signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (context.signal?.aborted) fail('PLUGIN_REQUEST_CANCELLED', 'The plugin document request was cancelled.', 499);
    if (record.revoked) fail('PLUGIN_HANDLE_REVOKED', 'The document handle has been revoked.');
    if (this.#clock() >= record.expiresAt) fail('PLUGIN_HANDLE_EXPIRED', 'The document handle has expired.');
    if (record.binding.pluginId !== context.binding.pluginId
      || record.binding.version !== context.binding.version
      || record.binding.packageHash !== context.binding.packageHash
      || record.binding.activationId !== context.binding.activationId
      || record.operationId !== context.operationId) {
      fail('PLUGIN_HANDLE_BINDING_MISMATCH', 'The document handle does not authorize this activation or operation.');
    }
    if (!record.methods.includes(method)) fail('PLUGIN_HANDLE_METHOD_DENIED', 'The document handle does not authorize this method.');
    if (consume && record.usageCount >= record.usageLimit) fail('PLUGIN_HANDLE_CONSUMED', 'The document handle usage limit has been reached.');
    const document = this.#documents.getDocument(record.documentId);
    if (document.sha256 !== record.sourceDigest) fail('PLUGIN_SOURCE_CHANGED', 'The document identity no longer matches this handle.', 409);
    if (consume) record.usageCount += 1;
    this.#grants.authorize(record.grantId, this.#grantContext(record, context, method), { consume });
    await this.#documents.verifySource(record.documentId);
    this.#assertStillAuthorized(record, context, method);
    return record;
  }

  #assertStillAuthorized(record, context, method) {
    if (record.revoked) fail('PLUGIN_HANDLE_REVOKED', 'The document handle has been revoked.');
    if (context.signal?.aborted) fail('PLUGIN_REQUEST_CANCELLED', 'The plugin document request was cancelled.', 499);
    this.#grants.authorize(record.grantId, this.#grantContext(record, context, method), { consume: false });
  }

  #grantContext(record, context, method) {
    return {
      binding: context.binding,
      document: { documentId: record.documentId, sourceDigest: record.sourceDigest },
      operationId: context.operationId,
      method,
    };
  }
}
