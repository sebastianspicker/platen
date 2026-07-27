/**
 * Local filesystem document repository connector.
 * list/get/put/lock against a workspace directory — not a network DMS.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  access, mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { HostError } from '../host-error.mjs';

const NAME = /^[A-Za-z0-9._-]{1,120}$/;

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class LocalDmsRepository {
  #root;

  constructor(root) {
    if (typeof root !== 'string' || root.length < 2) throw new TypeError('LocalDmsRepository requires a root path.');
    this.#root = root;
  }

  get root() { return this.#root; }

  async initialize() {
    await mkdir(join(this.#root, 'objects'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#root, 'locks'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#root, 'meta'), { recursive: true, mode: 0o700 });
    return this;
  }

  #objectPath(name) {
    if (!NAME.test(name)) fail('INVALID_OBJECT_NAME', 'Object name must be a safe filesystem token.');
    return join(this.#root, 'objects', name);
  }

  #lockPath(name) {
    if (!NAME.test(name)) fail('INVALID_OBJECT_NAME', 'Object name must be a safe filesystem token.');
    return join(this.#root, 'locks', `${name}.lock.json`);
  }

  async list() {
    const names = (await readdir(join(this.#root, 'objects'))).filter((name) => NAME.test(name)).sort();
    const items = [];
    for (const name of names) {
      const info = await stat(this.#objectPath(name));
      if (!info.isFile()) continue;
      items.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    }
    return Object.freeze({ root: this.#root, count: items.length, items: Object.freeze(items) });
  }

  async get(name) {
    const path = this.#objectPath(name);
    try {
      await access(path, fsConstants.R_OK);
    } catch {
      fail('OBJECT_NOT_FOUND', `Object not found: ${name}`, 404);
    }
    const bytes = await readFile(path);
    return Object.freeze({ name, bytes, sha256: digest(bytes), size: bytes.length });
  }

  async put(name, bytes, { ownerId = 'local', expectedSha256 = null } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 64 * 1024 * 1024) {
      fail('INVALID_OBJECT_BYTES', 'Object bytes must be a non-empty Buffer ≤64MiB.');
    }
    const lock = await this.#readLock(name);
    if (lock && lock.ownerId !== ownerId && lock.status === 'checked-out') {
      fail('DOCUMENT_LOCKED', 'Object is checked out by another owner.', 409);
    }
    if (expectedSha256) {
      try {
        const current = await this.get(name);
        if (current.sha256 !== expectedSha256) fail('VERSION_CONFLICT', 'expectedSha256 does not match current object.', 409);
      } catch (error) {
        if (error?.code !== 'OBJECT_NOT_FOUND') throw error;
      }
    }
    const target = this.#objectPath(name);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
    const sha = digest(bytes);
    await writeFile(join(this.#root, 'meta', `${name}.json`), JSON.stringify({ name, sha256: sha, size: bytes.length, updatedAt: new Date().toISOString(), ownerId }), { mode: 0o600 });
    return Object.freeze({ name, sha256: sha, size: bytes.length });
  }

  async checkout(name, ownerId) {
    const owner = String(ownerId ?? '');
    if (!owner || owner.length > 80) fail('INVALID_OWNER', 'ownerId required.');
    // Ensure object exists
    await this.get(name);
    const existing = await this.#readLock(name);
    if (existing && existing.status === 'checked-out' && existing.ownerId !== owner) {
      fail('DOCUMENT_LOCKED', 'Already checked out.', 409);
    }
    const lock = Object.freeze({
      name, ownerId: owner, status: 'checked-out', token: digest(Buffer.from(`${name}|${owner}|out`)), at: new Date().toISOString(),
    });
    await writeFile(this.#lockPath(name), JSON.stringify(lock), { mode: 0o600 });
    return lock;
  }

  async checkin(name, ownerId, token) {
    const lock = await this.#readLock(name);
    if (!lock || lock.status !== 'checked-out') fail('NOT_CHECKED_OUT', 'Object is not checked out.', 409);
    if (lock.ownerId !== ownerId || lock.token !== token) fail('LOCK_CONFLICT', 'Only the lock owner may check in.', 409);
    const released = Object.freeze({ ...lock, status: 'checked-in', releasedAt: new Date().toISOString() });
    await writeFile(this.#lockPath(name), JSON.stringify(released), { mode: 0o600 });
    return released;
  }

  async #readLock(name) {
    try {
      const raw = await readFile(this.#lockPath(name), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async destroy() {
    await rm(this.#root, { recursive: true, force: true });
  }
}

export async function openLocalDmsRepository(root) {
  const repo = new LocalDmsRepository(root);
  await repo.initialize();
  return repo;
}
