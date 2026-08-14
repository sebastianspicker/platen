import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';
import { TextDecoder, types } from 'node:util';
import { HostError } from './host-error.mjs';
import { canonicalizePluginPackage, sha256 } from './plugin-package-codec.mjs';

const STATE_SCHEMA_VERSION = 1;
const STATE_FILENAME = 'admin-policy.json';
const LOCK_FILENAME = '.admin-policy.lock';
const MAX_STATE_BYTES = 64 * 1024;
const ROOT_MODE = 0o700n;
const STATE_MODE = 0o600n;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set(['install', 'activate', 'rollback']);
const LOCK_RETRY_LIMIT = 200;
const LOCK_RETRY_DELAY_MS = 10;
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code, message, status = 500) {
  throw new HostError(code, message, status);
}

function isNotFound(error) { return error?.code === 'ENOENT'; }
function pause(milliseconds) { return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)); }

function hasExactDataKeys(value, expected) {
  if (types.isProxy(value) || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function assertSafeRoot(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777n) !== ROOT_MODE) {
    fail('ADMIN_POLICY_ROOT_UNSAFE', 'Admin policy root must be a private, non-symlink directory.');
  }
}

function assertSafeState(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || (metadata.mode & 0o777n) !== STATE_MODE) {
    fail('ADMIN_POLICY_STATE_UNSAFE', 'Admin policy state must be a private regular file.');
  }
}

function assertSafeLock(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || (metadata.mode & 0o777n) !== STATE_MODE) {
    fail('ADMIN_POLICY_BUSY', 'Admin policy storage is busy.', 503);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function publicState(revision, enabled) {
  const payload = {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision,
    policy: { pluginPackageAdministration: enabled },
  };
  return Object.freeze({
    ...payload,
    policy: Object.freeze(payload.policy),
    stateSha256: sha256(canonicalizePluginPackage(payload)),
  });
}

function parseState(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    fail('ADMIN_POLICY_STATE_INVALID', 'Admin policy state is not valid JSON.');
  }
  if (!hasExactDataKeys(parsed, ['policy', 'revision', 'schemaVersion', 'stateSha256'])
    || parsed.schemaVersion !== STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0
    || typeof parsed.stateSha256 !== 'string' || !SHA256.test(parsed.stateSha256)
    || !hasExactDataKeys(parsed.policy, ['pluginPackageAdministration'])
    || typeof parsed.policy.pluginPackageAdministration !== 'boolean') {
    fail('ADMIN_POLICY_STATE_INVALID', 'Admin policy state has an invalid schema.');
  }
  if (canonicalizePluginPackage(parsed) !== raw) {
    fail('ADMIN_POLICY_STATE_INVALID', 'Admin policy state must use canonical JSON.');
  }
  const payload = {
    schemaVersion: parsed.schemaVersion,
    revision: parsed.revision,
    policy: parsed.policy,
  };
  if (sha256(canonicalizePluginPackage(payload)) !== parsed.stateSha256) {
    fail('ADMIN_POLICY_STATE_INTEGRITY_FAILED', 'Admin policy state digest does not match its content.');
  }
  return publicState(parsed.revision, parsed.policy.pluginPackageAdministration);
}

async function syncDirectory(root) {
  let handle;
  try {
    handle = await open(root, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
    // Directory fsync is not available on every supported filesystem.
  } finally {
    await handle?.close();
  }
}

/** Stores the sole local authority for plugin package administration. */
export class LocalAdminPolicyAuthority {
  #root;
  #statePath;
  #lockPath;
  #state = publicState(0, false);
  #initialized = false;
  #initialization = null;
  #mutationTail = Promise.resolve();

  constructor({ root }) {
    if (typeof root !== 'string' || !root || root.includes('\0')) {
      throw new TypeError('Admin policy root is required.');
    }
    this.#root = resolve(root);
    this.#statePath = join(this.#root, STATE_FILENAME);
    this.#lockPath = join(this.#root, LOCK_FILENAME);
  }

  async initialize() {
    if (this.#initialized) return this;
    this.#initialization ??= this.#initialize();
    await this.#initialization;
    return this;
  }

  async list() {
    await this.initialize();
    return this.#state;
  }

  async setPluginPackageAdministration(input) {
    if (!hasExactDataKeys(input, ['enabled', 'expectedStateSha256'])
      || typeof input.enabled !== 'boolean'
      || typeof input.expectedStateSha256 !== 'string' || !SHA256.test(input.expectedStateSha256)) {
      fail('ADMIN_POLICY_INVALID', 'Admin policy update must contain enabled and expectedStateSha256.', 400);
    }
    await this.initialize();
    return this.#enqueue(() => this.#withLock(async () => {
      const current = await this.#readStableState();
      if (!current) fail('ADMIN_POLICY_STATE_INVALID', 'Admin policy state is unavailable.');
      this.#state = current;
      if (input.enabled === current.policy.pluginPackageAdministration) {
        return Object.freeze({ changed: false, state: current });
      }
      if (input.expectedStateSha256 !== current.stateSha256) {
        fail('ADMIN_POLICY_CONFLICT', 'Admin policy state changed before this update.', 409);
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        fail('ADMIN_POLICY_REVISION_EXHAUSTED', 'Admin policy revision cannot be incremented further.', 409);
      }
      const next = publicState(current.revision + 1, input.enabled);
      this.#state = next;
      try {
        await this.#persist(next);
      } catch (error) {
        if (!error?.committed) this.#state = current;
        throw error;
      }
      return Object.freeze({ changed: true, state: next });
    }));
  }

  async authorizePluginPackageMutation(action) {
    await this.initialize();
    return this.#withLock(async () => {
      const current = await this.#readStableState();
      if (!current) fail('ADMIN_POLICY_STATE_INVALID', 'Admin policy state is unavailable.');
      this.#state = current;
      if (!ACTIONS.has(action)) {
        fail('ADMIN_POLICY_ACTION_INVALID', 'Plugin package mutation action is invalid.', 400);
      }
      if (!current.policy.pluginPackageAdministration) {
        fail('ADMIN_POLICY_DENIED', 'Local administration policy denies plugin package mutation.', 403);
      }
      return true;
    });
  }

  async #initialize() {
    try {
      await this.#ensureRoot();
      await this.#withLock(async () => {
        const stored = await this.#readStableState();
        if (stored) this.#state = stored;
        else await this.#persist(this.#state);
      });
      this.#initialized = true;
    } catch (error) {
      if (error instanceof HostError) throw error;
      fail('ADMIN_POLICY_INITIALIZATION_FAILED', 'Admin policy storage could not be initialized.');
    }
  }

  async #ensureRoot() {
    let metadata;
    try { metadata = await lstat(this.#root, { bigint: true }); } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (!metadata) {
      await mkdir(this.#root, { recursive: true, mode: Number(ROOT_MODE) });
      metadata = await lstat(this.#root, { bigint: true });
    }
    assertSafeRoot(metadata);
  }

  async #readStableState() {
    let before;
    try { before = await lstat(this.#statePath, { bigint: true }); } catch (error) {
      if (isNotFound(error)) return null;
      fail('ADMIN_POLICY_STATE_UNSAFE', 'Admin policy state could not be validated.');
    }
    try {
      assertSafeState(before);
      if (before.size > BigInt(MAX_STATE_BYTES)) {
        fail('ADMIN_POLICY_STATE_TOO_LARGE', 'Admin policy state exceeds the local limit.', 413);
      }
      const handle = await open(this.#statePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true });
        assertSafeState(opened);
        if (!sameIdentity(before, opened)) {
          fail('ADMIN_POLICY_STATE_UNSAFE', 'Admin policy state changed while being read.');
        }
        const bytes = Buffer.allocUnsafe(Number(opened.size) + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== Number(opened.size)) {
          fail('ADMIN_POLICY_STATE_UNSAFE', 'Admin policy state changed while being read.');
        }
        const post = await handle.stat({ bigint: true });
        if (!sameIdentity(opened, post)) {
          fail('ADMIN_POLICY_STATE_UNSAFE', 'Admin policy state changed while being read.');
        }
        const after = await lstat(this.#statePath, { bigint: true });
        if (!sameIdentity(post, after)) {
          fail('ADMIN_POLICY_STATE_UNSAFE', 'Admin policy state changed while being read.');
        }
        return parseState(decoder.decode(bytes.subarray(0, offset)));
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (error) {
      if (error instanceof HostError) throw error;
      fail('ADMIN_POLICY_STATE_UNSAFE', 'Admin policy state could not be read safely.');
    }
  }

  async #persist(state) {
    const bytes = Buffer.from(canonicalizePluginPackage(state), 'utf8');
    if (bytes.length > MAX_STATE_BYTES) {
      fail('ADMIN_POLICY_STATE_TOO_LARGE', 'Admin policy state exceeds the local limit.', 413);
    }
    const temporaryPath = join(
      this.#root,
      `.${STATE_FILENAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    let handle;
    let renamed = false;
    try {
      assertSafeRoot(await lstat(this.#root, { bigint: true }));
      const target = await this.#stateTarget();
      if (target) assertSafeState(target);
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        Number(STATE_MODE),
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(Number(STATE_MODE));
      await handle.close();
      handle = null;
      await rename(temporaryPath, this.#statePath);
      renamed = true;
      await syncDirectory(this.#root);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      if (renamed) {
        const uncertain = new HostError(
          'ADMIN_POLICY_PERSIST_UNCERTAIN',
          'Admin policy state may have been persisted but durability was not confirmed.',
          500,
        );
        uncertain.committed = true;
        throw uncertain;
      }
      if (error instanceof HostError) throw error;
      fail('ADMIN_POLICY_PERSIST_FAILED', 'Admin policy state could not be persisted.');
    }
  }

  async #stateTarget() {
    try { return await lstat(this.#statePath, { bigint: true }); } catch (error) {
      if (isNotFound(error)) return null;
      fail('ADMIN_POLICY_STATE_UNSAFE', 'Admin policy state could not be validated.');
    }
  }

  async #withLock(operation) {
    const lock = await this.#acquireLock();
    try { return await operation(); } finally { await this.#releaseLock(lock); }
  }

  async #acquireLock() {
    for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
      let handle;
      try {
        handle = await open(
          this.#lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          Number(STATE_MODE),
        );
        const metadata = await handle.stat({ bigint: true });
        assertSafeLock(metadata);
        await handle.sync();
        await handle.close();
        return metadata;
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code !== 'EEXIST') {
          if (error instanceof HostError) throw error;
          fail('ADMIN_POLICY_BUSY', 'Admin policy storage is unavailable.', 503);
        }
        if (attempt + 1 === LOCK_RETRY_LIMIT) {
          fail('ADMIN_POLICY_BUSY', 'Admin policy storage is busy.', 503);
        }
        await pause(LOCK_RETRY_DELAY_MS);
      }
    }
    fail('ADMIN_POLICY_BUSY', 'Admin policy storage is busy.', 503);
  }

  async #releaseLock(lock) {
    try {
      const current = await lstat(this.#lockPath, { bigint: true });
      if (!sameIdentity(lock, current)) {
        fail('ADMIN_POLICY_BUSY', 'Admin policy storage is busy.', 503);
      }
      await unlink(this.#lockPath);
      await syncDirectory(this.#root);
    } catch (error) {
      if (error instanceof HostError) throw error;
      fail('ADMIN_POLICY_BUSY', 'Admin policy storage is busy.', 503);
    }
  }

  #enqueue(operation) {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.catch(() => {});
    return result;
  }
}
