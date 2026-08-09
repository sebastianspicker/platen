import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TextDecoder, types } from 'node:util';
import { HostError } from './host-error.mjs';

const SCHEMA_VERSION = 1;
const STATE_FILE = 'admin-audit.json';
const LOCK_FILE = '.admin-audit.lock';
const ROOT_MODE = 0o700n;
const FILE_MODE = 0o600n;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECORDS = 4096;
const ACTIONS = new Set(['policy.set', 'package.install', 'package.activate', 'package.rollback']);
const EVENT_ID = /^[A-Za-z0-9:._-]{1,192}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code, message, status = 500) { throw new HostError(code, message, status); }
function missing(error) { return error?.code === 'ENOENT'; }
function pause(milliseconds) { return new Promise((done) => setTimeout(done, milliseconds)); }
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('Canonical audit data must be JSON data.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function plain(value, keys) {
  if (types.isProxy(value) || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  return names.length === keys.length && names.every((key, index) => key === keys[index]
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function plainOptional(value, allowed) {
  if (types.isProxy(value) || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return false;
  return Object.getOwnPropertyNames(value).every((key) => allowed.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function same(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameRoot(left, right) { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode; }
function sameRenamedFile(left, right) { return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs; }

function assertRoot(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777n) !== ROOT_MODE) {
    fail('ADMIN_AUDIT_ROOT_UNSAFE', 'Admin audit root must be a private non-symlink directory.');
  }
}

function assertFile(metadata, code = 'ADMIN_AUDIT_STATE_UNSAFE') {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || (metadata.mode & 0o777n) !== FILE_MODE) fail(code, 'Admin audit storage is unsafe.');
}

function freezeRecord(record) { return Object.freeze({ ...record }); }

function freezeState(state) {
  return Object.freeze({ schemaVersion: state.schemaVersion, stateSha256: state.stateSha256,
    records: Object.freeze(state.records.map(freezeRecord)) });
}

function stateFor(records) {
  const payload = { schemaVersion: SCHEMA_VERSION, records };
  return freezeState({ ...payload, stateSha256: digest(payload) });
}

function eventFor(record) {
  const { eventSha256, ...payload } = record;
  return digest(payload);
}

function validateInput(input) {
  if (!plain(input, ['action', 'eventId', 'outcome', 'subject'])
    || typeof input.eventId !== 'string' || !EVENT_ID.test(input.eventId)
    || typeof input.action !== 'string' || !ACTIONS.has(input.action)
    || typeof input.subject !== 'string' || !/^[^\u0000-\u001F\u007F]{1,192}$/u.test(input.subject)
    || input.outcome !== 'succeeded') fail('ADMIN_AUDIT_INVALID', 'Admin audit event is invalid.', 400);
}

function validateState(raw, maximumRecords) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('ADMIN_AUDIT_STATE_INVALID', 'Admin audit state is not valid JSON.'); }
  if (!plain(parsed, ['records', 'schemaVersion', 'stateSha256']) || parsed.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(parsed.records) || parsed.records.length > maximumRecords
    || typeof parsed.stateSha256 !== 'string' || !SHA256.test(parsed.stateSha256)
    || canonical(parsed) !== raw) fail('ADMIN_AUDIT_STATE_INVALID', 'Admin audit state has an invalid canonical schema.');
  const seen = new Set(); let previous = 'GENESIS';
  for (let index = 0; index < parsed.records.length; index += 1) {
    const record = parsed.records[index];
    if (!plain(record, ['action', 'eventId', 'eventSha256', 'outcome', 'previousSha256', 'recordedAtLocal', 'sequence', 'subject', 'timestampTrust'])
      || !Number.isSafeInteger(record.sequence) || record.sequence !== index + 1
      || typeof record.eventId !== 'string' || !EVENT_ID.test(record.eventId) || seen.has(record.eventId)
      || typeof record.action !== 'string' || !ACTIONS.has(record.action)
      || typeof record.subject !== 'string' || !/^[^\u0000-\u001F\u007F]{1,192}$/u.test(record.subject)
      || record.outcome !== 'succeeded' || record.timestampTrust !== 'local-clock-untrusted'
      || typeof record.recordedAtLocal !== 'string' || !LOCAL_TIMESTAMP.test(record.recordedAtLocal)
      || record.previousSha256 !== previous || typeof record.eventSha256 !== 'string' || !SHA256.test(record.eventSha256)
      || eventFor(record) !== record.eventSha256) fail('ADMIN_AUDIT_CHAIN_INVALID', 'Admin audit chain is invalid.');
    seen.add(record.eventId); previous = record.eventSha256;
  }
  const payload = { schemaVersion: parsed.schemaVersion, records: parsed.records };
  if (digest(payload) !== parsed.stateSha256) fail('ADMIN_AUDIT_STATE_INTEGRITY_FAILED', 'Admin audit state digest does not match its content.');
  return freezeState(parsed);
}

async function syncDirectory(root) {
  let handle;
  try { handle = await open(root, fsConstants.O_RDONLY); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }
  finally { await handle?.close(); }
}

async function removeOwnedTemporary(path, metadata) {
  try { if (same(metadata, await lstat(path, { bigint: true }))) await unlink(path); } catch { /* preserve unknown entries */ }
}

/** Durable local audit chain for dedicated plugin-administration actions only. */
export class LocalAdminAuditAuthority {
  #root; #statePath; #lockPath; #state = stateFor([]); #initialized = false; #initialization = null;
  #tail = Promise.resolve(); #now; #maxBytes; #maxRecords; #beforeRename; #afterTemporaryVerified; #afterRename;

  constructor({ root, now = () => new Date(), maxBytes = DEFAULT_MAX_BYTES, maxRecords = DEFAULT_MAX_RECORDS, beforeRename = null, afterTemporaryVerified = null, afterRename = null }) {
    if (typeof root !== 'string' || !root || root.includes('\0') || typeof now !== 'function'
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES
      || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > DEFAULT_MAX_RECORDS
      || (beforeRename !== null && typeof beforeRename !== 'function')
      || (afterTemporaryVerified !== null && typeof afterTemporaryVerified !== 'function')
      || (afterRename !== null && typeof afterRename !== 'function')) {
      throw new TypeError('Admin audit configuration is invalid.');
    }
    this.#root = resolve(root); this.#statePath = join(this.#root, STATE_FILE); this.#lockPath = join(this.#root, LOCK_FILE);
    this.#now = now; this.#maxBytes = maxBytes; this.#maxRecords = maxRecords; this.#beforeRename = beforeRename;
    this.#afterTemporaryVerified = afterTemporaryVerified; this.#afterRename = afterRename;
  }

  async initialize() {
    if (this.#initialized) return this;
    this.#initialization ??= this.#initialize(); await this.#initialization; return this;
  }

  async append(input) {
    validateInput(input);
    const event = Object.freeze({ eventId: input.eventId, action: input.action, subject: input.subject, outcome: input.outcome });
    await this.initialize();
    return this.#enqueue(() => this.#withLock(async () => {
      const current = await this.#read(); this.#state = current;
      const existing = current.records.find((record) => record.eventId === event.eventId);
      if (existing) {
        if (existing.action === event.action && existing.subject === event.subject && existing.outcome === event.outcome) {
          return Object.freeze({ appended: false, record: existing });
        }
        fail('ADMIN_AUDIT_EVENT_CONFLICT', 'Admin audit event identifier conflicts with a prior event.', 409);
      }
      if (current.records.length >= this.#maxRecords) fail('ADMIN_AUDIT_FULL', 'Admin audit storage has reached its record limit.', 409);
      const date = this.#now();
      if (!(date instanceof Date) || Number.isNaN(date.valueOf())) fail('ADMIN_AUDIT_CLOCK_INVALID', 'Admin audit clock is invalid.');
      const previousSha256 = current.records.at(-1)?.eventSha256 ?? 'GENESIS';
      const record = { sequence: current.records.length + 1, previousSha256, eventId: event.eventId,
        action: event.action, subject: event.subject, outcome: event.outcome, recordedAtLocal: date.toISOString(), timestampTrust: 'local-clock-untrusted' };
      const next = stateFor([...current.records, { ...record, eventSha256: eventFor(record) }]);
      await this.#persist(next); this.#state = next;
      return Object.freeze({ appended: true, record: next.records.at(-1) });
    }));
  }

  async list(options = {}) {
    if (!plainOptional(options, ['limit'])) fail('ADMIN_AUDIT_LIMIT_INVALID', 'Admin audit list limit is invalid.', 400);
    const { limit = 100 } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('ADMIN_AUDIT_LIMIT_INVALID', 'Admin audit list limit is invalid.', 400);
    await this.initialize();
    return this.#withLock(async () => {
      const state = await this.#read(); this.#state = state;
      const records = Object.freeze(state.records.slice(-limit));
      return Object.freeze({ schemaVersion: SCHEMA_VERSION, count: state.records.length,
        head: state.records.at(-1)?.eventSha256 ?? 'GENESIS', stateSha256: state.stateSha256, records });
    });
  }

  async #initialize() {
    try { await this.#ensureRoot(); await this.#withLock(async () => {
      const stored = await this.#read(true); if (stored) this.#state = stored; else await this.#persist(this.#state);
    }); this.#initialized = true; }
    catch (error) { if (error instanceof HostError) throw error; fail('ADMIN_AUDIT_INITIALIZATION_FAILED', 'Admin audit storage could not be initialized.'); }
  }

  async #ensureRoot() {
    let metadata; try { metadata = await lstat(this.#root, { bigint: true }); } catch (error) { if (!missing(error)) throw error; }
    if (!metadata) { await mkdir(this.#root, { recursive: true, mode: Number(ROOT_MODE) }); metadata = await lstat(this.#root, { bigint: true }); }
    assertRoot(metadata);
  }

  async #read(allowMissing = false) {
    try { assertRoot(await lstat(this.#root, { bigint: true })); } catch (error) {
      if (error instanceof HostError) throw error;
      fail('ADMIN_AUDIT_ROOT_UNSAFE', 'Admin audit root must be a private non-symlink directory.');
    }
    let before; try { before = await lstat(this.#statePath, { bigint: true }); } catch (error) {
      if (missing(error) && allowMissing) return null; if (missing(error)) fail('ADMIN_AUDIT_STATE_INVALID', 'Admin audit state is unavailable.');
      fail('ADMIN_AUDIT_STATE_UNSAFE', 'Admin audit storage is unsafe.');
    }
    try {
      assertFile(before); if (before.size > BigInt(this.#maxBytes)) fail('ADMIN_AUDIT_STATE_TOO_LARGE', 'Admin audit state exceeds its bound.', 413);
      const handle = await open(this.#statePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true }); assertFile(opened);
        if (!same(before, opened)) fail('ADMIN_AUDIT_STATE_UNSAFE', 'Admin audit state changed while being read.');
        const bytes = Buffer.allocUnsafe(Number(opened.size)); let offset = 0;
        while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
        const after = await handle.stat({ bigint: true }); const pathAfter = await lstat(this.#statePath, { bigint: true });
        if (offset !== bytes.length || !same(opened, after) || !same(after, pathAfter)) fail('ADMIN_AUDIT_STATE_UNSAFE', 'Admin audit state changed while being read.');
        return validateState(decoder.decode(bytes), this.#maxRecords);
      } finally { await handle.close().catch(() => {}); }
    } catch (error) { if (error instanceof HostError) throw error; fail('ADMIN_AUDIT_STATE_UNSAFE', 'Admin audit storage is unsafe.'); }
  }

  async #persist(state) {
    const bytes = Buffer.from(canonical(state), 'utf8');
    if (bytes.length > this.#maxBytes) fail('ADMIN_AUDIT_STATE_TOO_LARGE', 'Admin audit state exceeds its bound.', 413);
    const temporary = join(this.#root, `.${STATE_FILE}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    let handle; let temporaryMetadata; let renamed = false;
    try {
      const rootMetadata = await lstat(this.#root, { bigint: true }); assertRoot(rootMetadata); const target = await this.#target(); if (target) assertFile(target);
      handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, Number(FILE_MODE));
      await handle.writeFile(bytes); await handle.chmod(Number(FILE_MODE)); await handle.sync(); temporaryMetadata = await handle.stat({ bigint: true }); assertFile(temporaryMetadata, 'ADMIN_AUDIT_TEMP_UNSAFE');
      await this.#beforeRename?.(temporary);
      const latest = await this.#target(); if ((target || latest) && (!target || !latest || !same(target, latest))) fail('ADMIN_AUDIT_STATE_UNSAFE', 'Admin audit state changed before replacement.');
      const rootBeforeRename = await lstat(this.#root, { bigint: true }); assertRoot(rootBeforeRename); if (!sameRoot(rootMetadata, rootBeforeRename)) fail('ADMIN_AUDIT_ROOT_UNSAFE', 'Admin audit root changed before replacement.');
      const currentTemporary = await this.#temporary(temporary); assertFile(currentTemporary, 'ADMIN_AUDIT_TEMP_UNSAFE'); if (!same(temporaryMetadata, currentTemporary)) fail('ADMIN_AUDIT_TEMP_UNSAFE', 'Admin audit temporary state changed before replacement.');
      await this.#afterTemporaryVerified?.(temporary);
      await rename(temporary, this.#statePath); renamed = true; await this.#afterRename?.(this.#statePath); await syncDirectory(this.#root);
      const [openedTemporary, finalState, rootAfterRename] = await Promise.all([handle.stat({ bigint: true }), lstat(this.#statePath, { bigint: true }), lstat(this.#root, { bigint: true })]);
      if (!sameRenamedFile(temporaryMetadata, openedTemporary) || !sameRenamedFile(openedTemporary, finalState) || !sameRoot(rootBeforeRename, rootAfterRename)) {
        fail('ADMIN_AUDIT_PERSIST_UNCERTAIN', 'Admin audit persistence could not be confirmed.');
      }
      assertFile(finalState, 'ADMIN_AUDIT_PERSIST_UNCERTAIN'); await handle.close(); handle = null;
    } catch (error) {
      await handle?.close().catch(() => {}); if (temporaryMetadata) await removeOwnedTemporary(temporary, temporaryMetadata);
      if (renamed) { const uncertain = new HostError('ADMIN_AUDIT_PERSIST_UNCERTAIN', 'Admin audit state may have been persisted but durability was not confirmed.'); uncertain.committed = true; throw uncertain; }
      if (error instanceof HostError) throw error; fail('ADMIN_AUDIT_PERSIST_FAILED', 'Admin audit state could not be persisted.');
    }
  }

  async #target() { try { return await lstat(this.#statePath, { bigint: true }); } catch (error) { if (missing(error)) return null; fail('ADMIN_AUDIT_STATE_UNSAFE', 'Admin audit storage is unsafe.'); } }
  async #temporary(path) { try { return await lstat(path, { bigint: true }); } catch { fail('ADMIN_AUDIT_TEMP_UNSAFE', 'Admin audit temporary state is unavailable.'); } }
  async #withLock(work) { const lock = await this.#lock(); try { return await work(); } finally { await this.#unlock(lock); } }
  async #lock() {
    if (!Number.isInteger(fsConstants.O_NOFOLLOW)) fail('ADMIN_AUDIT_UNSUPPORTED', 'Admin audit requires no-follow file opens.');
    try { assertRoot(await lstat(this.#root, { bigint: true })); } catch (error) {
      if (error instanceof HostError) throw error;
      fail('ADMIN_AUDIT_ROOT_UNSAFE', 'Admin audit root must be a private non-symlink directory.');
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let handle;
      try {
        handle = await open(this.#lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, Number(FILE_MODE));
        const metadata = await handle.stat({ bigint: true }); assertFile(metadata, 'ADMIN_AUDIT_BUSY'); await handle.sync(); await handle.close(); return metadata;
      } catch (error) { await handle?.close().catch(() => {}); if (error?.code !== 'EEXIST') { if (error instanceof HostError) throw error; fail('ADMIN_AUDIT_BUSY', 'Admin audit storage is unavailable.', 503); } await pause(10); }
    }
    fail('ADMIN_AUDIT_BUSY', 'Admin audit storage is busy.', 503);
  }
  async #unlock(lock) {
    try { const current = await lstat(this.#lockPath, { bigint: true }); if (!same(lock, current)) fail('ADMIN_AUDIT_BUSY', 'Admin audit storage is busy.', 503); await unlink(this.#lockPath); await syncDirectory(this.#root); }
    catch (error) { if (error instanceof HostError) throw error; fail('ADMIN_AUDIT_BUSY', 'Admin audit storage is busy.', 503); }
  }
  #enqueue(work) { const result = this.#tail.then(work); this.#tail = result.catch(() => {}); return result; }
}
