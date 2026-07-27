import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';
import { HostError } from './host-error.mjs';
import { canonicalizePluginPackage, sha256 } from './plugin-package-codec.mjs';
import { TrustedPublisherStore } from './trusted-publisher-store.mjs';

const STATE_SCHEMA_VERSION = 1;
const STATE_FILENAME = 'trusted-publishers.json';
const MAX_STATE_BYTES = 1024 * 1024;
const ROOT_MODE = 0o700;
const STATE_MODE = 0o600;
const PUBLIC_PROJECTION_FIELDS = Object.freeze([
  'publisherId', 'keyId', 'fingerprint', 'pluginIds', 'revoked',
]);

function fail(code, message, status = 500, options) {
  throw new HostError(code, message, status, options);
}

function isExpectedNotFound(error) { return error?.code === 'ENOENT'; }

function canonical(value) { return canonicalizePluginPackage(value); }

function assertSafeRootMetadata(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 2
    || (metadata.mode & 0o077) !== 0) {
    fail('TRUST_ROOT_UNSAFE', 'Publisher trust root must be a private, non-symlink directory.');
  }
}

function assertSafeStateMetadata(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o777) !== STATE_MODE) {
    fail('TRUST_STATE_UNSAFE', 'Publisher trust state must be a private regular file.');
  }
}

function projection(entry) {
  const result = {};
  for (const field of PUBLIC_PROJECTION_FIELDS) {
    result[field] = field === 'pluginIds' ? Object.freeze([...entry.pluginIds]) : entry[field];
  }
  return Object.freeze(result);
}

function publicState(store) {
  const state = store.exportState();
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    publishers: Object.freeze(state.publishers.map(projection)),
  });
}

function statePayload(store) {
  const state = store.exportState();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    publishers: state.publishers,
  };
}

function stateEnvelope(store) {
  const payload = statePayload(store);
  return {
    ...payload,
    stateSha256: sha256(canonical(payload)),
  };
}

function stateWithoutDigest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('TRUST_STATE_INVALID', 'Publisher trust state must be an object.');
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\0') !== ['publishers', 'schemaVersion', 'stateSha256'].join('\0')) {
    fail('TRUST_STATE_INVALID', 'Publisher trust state contains unknown fields.');
  }
  if (value.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(value.publishers)
    || typeof value.stateSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.stateSha256)) {
    fail('TRUST_STATE_INVALID', 'Publisher trust state is invalid.');
  }
  return { schemaVersion: value.schemaVersion, publishers: value.publishers };
}

async function syncDirectory(root) {
  let handle;
  try {
    handle = await open(root, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not available on every supported filesystem.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class PublisherTrustAuthority {
  #root;
  #statePath;
  #store = new TrustedPublisherStore();
  #initialized = false;
  #initialization = null;
  #mutationTail = Promise.resolve();

  constructor({ root }) {
    if (typeof root !== 'string' || !root || root.includes('\0')) {
      throw new TypeError('Publisher trust root is required.');
    }
    this.#root = resolve(root);
    this.#statePath = join(this.#root, STATE_FILENAME);
  }

  get root() { return this.#root; }

  get statePath() { return this.#statePath; }

  // Plugin verification must receive this exact TrustedPublisherStore instance.
  get store() { return this.#store; }

  get trustedPublisherStore() { return this.#store; }

  async initialize() {
    if (this.#initialized) return this;
    this.#initialization ??= this.#initialize();
    await this.#initialization;
    return this;
  }

  async #initialize() {
    let rootMetadata;
    try { rootMetadata = await lstat(this.#root); } catch (error) {
      if (!isExpectedNotFound(error)) throw error;
    }
    if (!rootMetadata) {
      await mkdir(this.#root, { recursive: true, mode: ROOT_MODE });
      rootMetadata = await lstat(this.#root);
    }
    assertSafeRootMetadata(rootMetadata);
    if ((rootMetadata.mode & 0o777) !== ROOT_MODE) {
      await chmod(this.#root, ROOT_MODE);
      rootMetadata = await lstat(this.#root);
      assertSafeRootMetadata(rootMetadata);
    }

    let stateMetadata;
    try { stateMetadata = await lstat(this.#statePath); } catch (error) {
      if (!isExpectedNotFound(error)) throw error;
    }
    if (!stateMetadata) {
      await this.#persist();
    } else {
      assertSafeStateMetadata(stateMetadata);
      await this.#load(stateMetadata);
    }
    this.#initialized = true;
  }

  async #load(metadata) {
    if (metadata.size > MAX_STATE_BYTES) {
      fail('TRUST_STATE_TOO_LARGE', 'Publisher trust state exceeds the local limit.', 413);
    }
    let raw;
    try { raw = await readFile(this.#statePath, 'utf8'); } catch (error) {
      fail('TRUST_STATE_INVALID', 'Publisher trust state could not be read.', 500, { cause: error });
    }
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) {
      fail('TRUST_STATE_TOO_LARGE', 'Publisher trust state exceeds the local limit.', 413);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
      fail('TRUST_STATE_INVALID', 'Publisher trust state is not valid JSON.', 500, { cause: error });
    }
    const payload = stateWithoutDigest(parsed);
    if (canonical(parsed) !== raw) {
      fail('TRUST_STATE_INVALID', 'Publisher trust state must use canonical JSON.');
    }
    if (sha256(canonical(payload)) !== parsed.stateSha256) {
      fail('TRUST_STATE_INTEGRITY_FAILED', 'Publisher trust state digest does not match its content.');
    }
    try {
      this.#store.importState(payload);
    } catch (error) {
      fail('TRUST_STATE_INVALID', 'Publisher trust state failed validation.', 500, { cause: error });
    }
  }

  async #persist() {
    const rootMetadata = await lstat(this.#root);
    assertSafeRootMetadata(rootMetadata);
    const bytes = Buffer.from(canonical(stateEnvelope(this.#store)), 'utf8');
    if (bytes.length > MAX_STATE_BYTES) {
      fail('TRUST_STATE_TOO_LARGE', 'Publisher trust state exceeds the local limit.', 413);
    }
    const temporaryPath = join(
      this.#root,
      `.${STATE_FILENAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, STATE_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(STATE_MODE);
      await handle.close();
      handle = null;
      await rename(temporaryPath, this.#statePath);
      await syncDirectory(this.#root);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      fail('TRUST_STATE_PERSIST_FAILED', 'Publisher trust state could not be persisted.', 500, { cause: error });
    }
  }

  #enqueue(operation) {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.catch(() => {});
    return result;
  }

  #assertInitialized() {
    if (!this.#initialized) throw new Error('Publisher trust authority must be initialized first.');
  }

  async list() {
    await this.initialize();
    return publicState(this.#store);
  }

  exportState() {
    this.#assertInitialized();
    return publicState(this.#store);
  }

  get(publisherId, keyId) { return this.#store.get(publisherId, keyId); }

  async enroll(input) {
    await this.initialize();
    return this.#enqueue(async () => {
      const before = this.#store.exportState();
      let enrolled;
      try {
        enrolled = this.#store.enroll(input);
        await this.#persist();
      } catch (error) {
        this.#store.importState(before);
        throw error;
      }
      return projection({ ...enrolled, revoked: false });
    });
  }

  async revoke({ publisherId, keyId }) {
    await this.initialize();
    return this.#enqueue(async () => {
      const current = this.#store.get(publisherId, keyId);
      if (!current) fail('TRUST_KEY_NOT_FOUND', 'Trusted publisher key was not found.', 404);
      if (current.revoked) return this.#entryProjection(publisherId, keyId);
      const before = this.#store.exportState();
      try {
        this.#store.revoke({ publisherId, keyId });
        await this.#persist();
      } catch (error) {
        this.#store.importState(before);
        throw error;
      }
      return this.#entryProjection(publisherId, keyId);
    });
  }

  async unrevoke({ publisherId, keyId }) {
    await this.initialize();
    return this.#enqueue(async () => {
      const current = this.#store.get(publisherId, keyId);
      if (!current) fail('TRUST_KEY_NOT_FOUND', 'Trusted publisher key was not found.', 404);
      if (!current.revoked) return this.#entryProjection(publisherId, keyId);
      const before = this.#store.exportState();
      try {
        const next = structuredClone(this.#store.exportState());
        const entry = next.publishers.find((item) => item.publisherId === publisherId && item.keyId === keyId);
        entry.revoked = false;
        this.#store.importState(next);
        await this.#persist();
      } catch (error) {
        this.#store.importState(before);
        throw error;
      }
      return this.#entryProjection(publisherId, keyId);
    });
  }

  async remove({ publisherId, keyId, fingerprint, expectedFingerprint, expectedSha256 }) {
    await this.initialize();
    return this.#enqueue(async () => {
      const current = this.#store.get(publisherId, keyId);
      if (!current) fail('TRUST_KEY_NOT_FOUND', 'Trusted publisher key was not found.', 404);
      const expected = expectedFingerprint ?? expectedSha256 ?? fingerprint;
      const actual = sha256(current.publicKey.export({ type: 'spki', format: 'der' }));
      if (typeof expected !== 'string' || expected !== actual) {
        fail('TRUST_KEY_FINGERPRINT_MISMATCH', 'Publisher key fingerprint confirmation did not match.', 409);
      }
      const before = this.#store.exportState();
      try {
        const next = {
          ...before,
          publishers: before.publishers.filter((entry) => !(entry.publisherId === publisherId && entry.keyId === keyId)),
        };
        this.#store.importState(next);
        await this.#persist();
      } catch (error) {
        this.#store.importState(before);
        throw error;
      }
      return Object.freeze({ publisherId, keyId, fingerprint: actual, removed: true });
    });
  }

  #entryProjection(publisherId, keyId) {
    const current = this.#store.get(publisherId, keyId);
    return projection({
      publisherId,
      keyId,
      fingerprint: sha256(current.publicKey.export({ type: 'spki', format: 'der' })),
      pluginIds: current.pluginIds,
      revoked: current.revoked,
    });
  }
}

export function createPublisherTrustAuthority(options) {
  return new PublisherTrustAuthority(options);
}

export const PUBLISHER_TRUST_STATE_FILENAME = STATE_FILENAME;
export const PUBLISHER_TRUST_MAX_STATE_BYTES = MAX_STATE_BYTES;
