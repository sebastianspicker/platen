import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_SCHEDULE_MAX_RECORD_BYTES,
  AUTOMATION_SCHEDULE_MAX_RUNS,
  AUTOMATION_SCHEDULE_MAX_SCHEDULES,
  AUTOMATION_SCHEDULE_SCHEMA_VERSION,
  normalizeAutomationScheduleCreateRequest,
  scheduleOccurrenceKey,
} from './automation-scheduled-jobs-contract.mjs';

const FILE_MODE = 0o600;
const ROOT_MODE = 0o700;

function storageFail(code, message, status = 500, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY);
  try { await handle.sync(); } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally { await handle.close(); }
}

async function privateRoot(root) {
  try {
    const entry = await lstat(root, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isDirectory()) storageFail('AUTOMATION_SCHEDULE_STORAGE_UNSAFE', 'Schedule storage root must be a private directory.');
    if ((entry.mode & 0o077n) !== 0n) await chmod(root, ROOT_MODE);
    const checked = await lstat(root, { bigint: true });
    if (checked.isSymbolicLink() || !checked.isDirectory() || (checked.mode & 0o077n) !== 0n) storageFail('AUTOMATION_SCHEDULE_STORAGE_UNSAFE', 'Schedule storage root must be private.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true, mode: ROOT_MODE });
    const checked = await lstat(root, { bigint: true });
    if (checked.isSymbolicLink() || !checked.isDirectory() || (checked.mode & 0o077n) !== 0n) storageFail('AUTOMATION_SCHEDULE_STORAGE_UNSAFE', 'Schedule storage root must be private.');
  }
}

async function safeFile(path, { allowMissing = false } = {}) {
  let before;
  try { before = await lstat(path, { bigint: true }); } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n
    || (before.mode & 0o077n) !== 0n || before.size > BigInt(AUTOMATION_SCHEDULE_MAX_RECORD_BYTES)) {
    storageFail('AUTOMATION_SCHEDULE_STORAGE_UNSAFE', 'Schedule state file is unsafe.');
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size !== before.size) {
      storageFail('AUTOMATION_SCHEDULE_STORAGE_UNSAFE', 'Schedule state file changed while opening.');
    }
    const data = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < data.length) {
      const chunk = await handle.read(data, offset, data.length - offset, offset);
      if (!chunk.bytesRead) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule state file was truncated.');
      offset += chunk.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule state file changed while reading.');
    }
    return data;
  } finally { await handle.close(); }
}

async function writeAtomic(path, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > AUTOMATION_SCHEDULE_MAX_RECORD_BYTES) storageFail('AUTOMATION_SCHEDULE_STORAGE_FULL', 'Schedule state exceeds its fixed size bound.');
  const existing = await safeFile(path, { allowMissing: true });
  // safeFile has validated an existing target. Never replace a symlink or hard link.
  void existing;
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), FILE_MODE);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await syncDirectory(join(path, '..'));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error instanceof HostError) throw error;
    storageFail('AUTOMATION_SCHEDULE_STORAGE_WRITE_FAILED', 'Schedule state could not be written atomically.', 500, error);
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function descriptors(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', `${label} is invalid.`);
  const result = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !Object.hasOwn(result, key) || !Object.hasOwn(result[key], 'value') || result[key].enumerable !== true)) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', `${label} contains an accessor.`);
  return result;
}

function exactKeys(value, expected, label) {
  const result = descriptors(value, label);
  if (Reflect.ownKeys(result).length !== expected.length || expected.some((key) => !Object.hasOwn(result, key))) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', `${label} shape is invalid.`);
  return result;
}

function dense(value, label) {
  if (!Array.isArray(value)) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', `${label} is invalid.`);
  const result = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key) || Number(key) >= value.length || !Object.hasOwn(result, key) || !Object.hasOwn(result[key], 'value') || result[key].enumerable !== true))) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', `${label} is not dense.`);
  return Array.from({ length: value.length }, (_, index) => result[String(index)].value);
}

function validateState(state) {
  if (!plainObject(state)) {
    storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule state is corrupt.');
  }
  const stateFields = exactKeys(state, ['schemaVersion', 'schedules'], 'Schedule state');
  if (stateFields.schemaVersion.value !== AUTOMATION_SCHEDULE_SCHEMA_VERSION
    || !Array.isArray(stateFields.schedules.value) || stateFields.schedules.value.length > AUTOMATION_SCHEDULE_MAX_SCHEDULES
    || stateFields.schedules.value.some((item) => !plainObject(item))) {
    storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule state is corrupt.');
  }
  const ids = new Set();
  for (const item of stateFields.schedules.value) {
    const record = exactKeys(item, ['createdAt', 'firstAt', 'grant', 'intervalMs', 'nextAt', 'operation', 'principal', 'runCount', 'runs', 'scheduleId', 'schemaVersion', 'source', 'status', 'updatedAt'], 'Schedule record');
    const source = exactKeys(record.source.value, ['id', 'sha256'], 'Schedule source');
    const operation = exactKeys(record.operation.value, ['id', 'kind', 'pages'], 'Schedule operation');
    const grant = exactKeys(record.grant.value, ['grantId', 'principal'], 'Schedule grant');
    const runs = dense(record.runs.value, 'Schedule runs');
    if (typeof record.scheduleId.value !== 'string' || ids.has(record.scheduleId.value)
      || typeof record.principal.value !== 'string' || grant.principal.value !== record.principal.value
      || typeof grant.grantId.value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(grant.grantId.value)
      || !['enabled', 'disabled', 'cancelled', 'completed'].includes(record.status.value)
      || runs.length > AUTOMATION_SCHEDULE_MAX_RUNS
      || !Number.isSafeInteger(record.runCount.value) || record.runCount.value < 0 || record.runCount.value > AUTOMATION_SCHEDULE_MAX_RUNS
      || !Number.isSafeInteger(record.firstAt.value) || record.firstAt.value < 0
      || (record.intervalMs.value !== null && (!Number.isSafeInteger(record.intervalMs.value) || record.intervalMs.value < 60_000))
      || (record.nextAt.value !== null && (!Number.isSafeInteger(record.nextAt.value) || record.nextAt.value < 0))
      || !Number.isSafeInteger(record.createdAt.value) || !Number.isSafeInteger(record.updatedAt.value) || record.updatedAt.value < record.createdAt.value
      || typeof source.id.value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(source.id.value)
      || typeof source.sha256.value !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256.value)) {
      storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule state record is invalid.');
    }
    try {
      normalizeAutomationScheduleCreateRequest({ scheduleId: record.scheduleId.value, principal: record.principal.value, grant: grantValue(grant), source: sourceValue(source), operation: operationValue(operation), firstAt: record.firstAt.value, intervalMs: record.intervalMs.value }, 0);
    } catch (error) { storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule state operation policy is invalid.', 500, error); }
    if (['enabled', 'disabled'].includes(record.status.value) && record.nextAt.value === null) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Enabled schedule has no next occurrence.');
    if (record.status.value === 'completed' && record.nextAt.value !== null) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Completed schedule has a next occurrence.');
    const occurrences = new Set();
    let previousScheduledAt = -1;
    const queued = runs.filter((run) => {
      const runRecord = exactKeys(run, ['errorCode', 'finishedAt', 'jobId', 'occurrence', 'scheduledAt', 'startedAt', 'status'], 'Schedule run');
      if (!['admitting', 'pending', 'queued'].includes(runRecord.status.value) || typeof runRecord.occurrence.value !== 'string'
        || !Number.isSafeInteger(runRecord.scheduledAt.value) || runRecord.scheduledAt.value < 0
        || (runRecord.jobId.value !== null && (typeof runRecord.jobId.value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(runRecord.jobId.value)))
        || (runRecord.errorCode.value !== null && (typeof runRecord.errorCode.value !== 'string' || !/^[A-Z0-9_.-]{1,64}$/u.test(runRecord.errorCode.value)))
        || (runRecord.startedAt.value !== null && (!Number.isSafeInteger(runRecord.startedAt.value) || runRecord.startedAt.value < 0))
        || (runRecord.finishedAt.value !== null && (!Number.isSafeInteger(runRecord.finishedAt.value) || runRecord.finishedAt.value < 0))) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule run record is invalid.');
      let expectedOccurrence;
      try { expectedOccurrence = scheduleOccurrenceKey(record.scheduleId.value, runRecord.scheduledAt.value); } catch (error) { storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule occurrence is invalid.', 500, error); }
      if (runRecord.occurrence.value !== expectedOccurrence || occurrences.has(runRecord.occurrence.value) || runRecord.scheduledAt.value < previousScheduledAt) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule occurrences are inconsistent.');
      occurrences.add(runRecord.occurrence.value);
      previousScheduledAt = runRecord.scheduledAt.value;
      if (runRecord.status.value === 'queued' && (runRecord.jobId.value === null || runRecord.finishedAt.value === null)) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Queued schedule run is incomplete.');
      return runRecord.status.value === 'queued';
    });
    if (queued.length !== record.runCount.value || (record.status.value === 'completed' && record.nextAt.value !== null)) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule run counters are inconsistent.');
    ids.add(record.scheduleId.value);
  }
  return state;
}

function grantValue(value) { return { grantId: value.grantId.value, principal: value.principal.value }; }
function sourceValue(value) { return { id: value.id.value, sha256: value.sha256.value }; }
function operationValue(value) { return { id: value.id.value, kind: value.kind.value, pages: value.pages.value }; }

export class AutomationScheduleStore {
  #root; #statePath; #lockPath; #lock; #lockIdentity; #state; #mutation = Promise.resolve(); #closed = false;

  constructor({ root } = {}) {
    if (typeof root !== 'string' || !root) storageFail('AUTOMATION_SCHEDULE_STORAGE_UNSAFE', 'Schedule storage root is required.', 400);
    this.#root = root;
    this.#statePath = join(root, 'schedules.json');
    this.#lockPath = join(root, '.owner.lock');
  }

  async initialize() {
    if (this.#state || this.#closed) storageFail('AUTOMATION_SCHEDULE_LIFECYCLE_INVALID', 'Schedule store cannot be initialized again.', 409);
    await privateRoot(this.#root);
    let lock;
    let created = false;
    try {
      lock = await open(this.#lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), FILE_MODE);
      created = true;
      this.#lockIdentity = await lock.stat({ bigint: true });
      await lock.writeFile(JSON.stringify({ pid: process.pid, schemaVersion: AUTOMATION_SCHEDULE_SCHEMA_VERSION, token: randomUUID() }));
      await lock.sync();
      this.#lock = lock;
      await syncDirectory(this.#root);
    } catch (error) {
      await lock?.close().catch(() => {});
      if (created) await this.#removeOwnedLock().catch(() => {});
      if (error?.code === 'EEXIST') storageFail('AUTOMATION_SCHEDULE_ALREADY_OPEN', 'Schedule storage already has a live owner.', 409);
      throw error;
    }
    try {
      const bytes = await safeFile(this.#statePath, { allowMissing: true });
      if (!bytes) this.#state = { schemaVersion: AUTOMATION_SCHEDULE_SCHEMA_VERSION, schedules: [] };
      else {
        let parsed;
        try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) { storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule state is not valid JSON.', 500, error); }
        if (JSON.stringify(parsed) !== bytes.toString('utf8')) storageFail('AUTOMATION_SCHEDULE_STORAGE_CORRUPT', 'Schedule state is not canonical.');
        this.#state = validateState(parsed);
      }
      await writeAtomic(this.#statePath, this.#state);
      return this;
    } catch (error) {
      await this.#lock?.close().catch(() => {});
      this.#lock = null;
      await this.#removeOwnedLock().catch(() => {});
      await syncDirectory(this.#root).catch(() => {});
      throw error;
    }
  }

  async read() {
    await this.#mutation;
    if (!this.#state || this.#closed) storageFail('AUTOMATION_SCHEDULE_LIFECYCLE_INVALID', 'Schedule store is not initialized.', 409);
    return structuredClone(this.#state);
  }

  mutate(callback) {
    const run = this.#mutation.then(async () => {
      if (!this.#state || this.#closed) storageFail('AUTOMATION_SCHEDULE_LIFECYCLE_INVALID', 'Schedule store is not initialized.', 409);
      const candidate = structuredClone(this.#state);
      const result = await callback(candidate);
      validateState(candidate);
      await writeAtomic(this.#statePath, candidate);
      this.#state = candidate;
      return result;
    });
    this.#mutation = run.catch(() => {});
    return run;
  }

  async close() {
    if (this.#closed) return;
    await this.#mutation;
    this.#closed = true;
    this.#state = null;
    await this.#removeOwnedLock();
    await syncDirectory(this.#root).catch(() => {});
    await this.#lock?.close().catch(() => {});
    this.#lock = null;
  }

  async #removeOwnedLock() {
    if (!this.#lockIdentity) return;
    try {
      const current = await lstat(this.#lockPath, { bigint: true });
      if (current.isFile() && current.nlink === 1n && current.dev === this.#lockIdentity.dev && current.ino === this.#lockIdentity.ino) await unlink(this.#lockPath);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.#lockIdentity = null;
  }

  [Symbol.asyncDispose]() { return this.close(); }
}

export const DurableLocalScheduleStore = AutomationScheduleStore;
