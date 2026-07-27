import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { stagePrivateSourceCopy } from '../private-source-copy.mjs';
import {
  checkedPrivateFile, digestHandle, existingPrivateDirectory, fail,
  MAX_RECORD_BYTES, MAX_SOURCE_BYTES, MAX_SOURCE_RECORDS, MAX_SOURCE_STORE_BYTES,
  OPAQUE_ID, readPrivateFile, sameIdentity, SHA256, SOURCE_RECORD_VERSION,
  sourceRecord, syncDirectory, throwIfAborted,
  readTransactionJournal, transactionMarker,
  transactionReference, writePrivateJson, TRANSACTION_VERSION, sameTransactionReference,
} from './automation-store-support.mjs';

export class AutomationSourceRecordStore {
  #root; #idFactory; #created = new WeakSet();

  constructor({ root, idFactory }) {
    this.#root = root;
    this.#idFactory = idFactory;
  }

  async stageDocument({ store, documentId, signal } = {}) {
    if (!store || typeof store.getDocument !== 'function'
      || typeof store.getSourcePath !== 'function' || typeof store.verifySource !== 'function'
      || typeof documentId !== 'string'
      || (signal !== undefined && (signal === null || typeof signal !== 'object'
        || typeof signal.aborted !== 'boolean'))) {
      fail('INVALID_AUTOMATION_SOURCE', 'Automation staging requires one private document.');
    }
    throwIfAborted(signal);
    const document = store.getDocument(documentId);
    await store.verifySource(documentId);
    if (!SHA256.test(document.sha256) || !Number.isSafeInteger(document.size)
      || document.size < 5 || document.size > MAX_SOURCE_BYTES) {
      fail('INVALID_AUTOMATION_SOURCE', 'Automation input exceeds the durable source policy.');
    }
    const inventory = await this.#inventory();
    const existing = inventory.records.find((record) => record.sha256 === document.sha256);
    if (existing) {
      if (existing.size !== document.size) {
        fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source digest has conflicting metadata.', 500);
      }
      const handle = await this.#openSource(existing);
      await handle.close();
      return existing;
    }
    if (inventory.records.length >= MAX_SOURCE_RECORDS
      || inventory.totalBytes + document.size > MAX_SOURCE_STORE_BYTES) {
      fail('AUTOMATION_SOURCE_QUOTA', 'Automation source storage has reached its fixed quota.', 507);
    }
    return this.#createSource(store, documentId, document, signal);
  }

  async openVerified(id, expectedSha256) {
    if (!OPAQUE_ID.test(id) || !SHA256.test(expectedSha256)) {
      fail('AUTOMATION_SOURCE_NOT_FOUND', 'Automation source was not found.', 404);
    }
    const record = await this.#readRecord(id);
    if (record.sha256 !== expectedSha256) {
      fail('AUTOMATION_SOURCE_MISMATCH', 'Automation source digest does not match the queued operation.', 409);
    }
    const handle = await this.#openSource(record);
    const stream = handle.createReadStream({ autoClose: true, start: 0, end: record.size - 1 });
    return Object.freeze({ ...record, stream });
  }

  commit(source) {
    return this.#setTransactionState(source.id, 'committed').then(() => {
      this.#created.delete(source);
    });
  }

  async recoverTransactions(references = {}) {
    const committed = new Map((references.committed ?? []).filter((ref) => ref?.kind === 'source').map((ref) => [ref.id, ref]));
    const discard = new Map((references.discard ?? []).filter((ref) => ref?.kind === 'source').map((ref) => [ref.id, ref]));
    const journal = await readTransactionJournal(this.#root, 'source');
    const names = await readdir(this.#root, { withFileTypes: true });
    let recovered = 0; let removed = 0; let legacyPreserved = 0;
    const seen = new Set(); const present = new Set();
    for (const entry of names) {
      if (entry.name === 'transactions.json') continue;
      if (!entry.isDirectory() || !OPAQUE_ID.test(entry.name)) fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source storage contains an unsafe entry.', 500);
      const record = await this.#readRecord(entry.name);
      const children = await readdir(join(this.#root, entry.name), { withFileTypes: true });
      let marker;
      try { marker = transactionMarker(await readPrivateFile(join(this.#root, entry.name, 'transaction.json'), MAX_RECORD_BYTES), 'source'); }
      catch (error) {
        if (error?.code === 'ENOENT') {
          if (children.length !== 2 || children.some((child) => !['record.json', 'source.pdf'].includes(child.name) || !child.isFile())) fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source record contains an unexpected entry.', 500);
          legacyPreserved += 1; continue;
        }
        throw error;
      }
      if (children.length !== 3 || children.some((child) => !['record.json', 'source.pdf', 'transaction.json'].includes(child.name) || !child.isFile())) fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source transaction contains an unexpected entry.', 500);
      const ref = transactionReference('source', record);
      present.add(record.id);
      if (!sameTransactionReference(marker.ref, ref)) fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source transaction binding is invalid.', 500);
      const wanted = committed.get(record.id);
      const doomed = discard.get(record.id);
      if (wanted && !sameTransactionReference(wanted, ref)) fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source committed transaction does not match the record.', 500);
      if (wanted) seen.add(record.id);
      if (marker.state === 'staged' && wanted && sameTransactionReference(wanted, ref)) {
        await this.#writeMarker(ref, 'committed'); recovered += 1;
      } else if (doomed && !sameTransactionReference(doomed, ref)) {
        fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source discard transaction does not match the record.', 500);
      } else if (marker.state === 'staged' && (!wanted || doomed)) {
        const handle = await this.#openSource(record); await handle.close();
        await this.#removeRecord(record.id); removed += 1;
      }
    }
    for (const entry of journal) if (!present.has(entry.ref.id)
      && (!discard.has(entry.ref.id) || !sameTransactionReference(discard.get(entry.ref.id), entry.ref))) fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source transaction journal is not reconciled.', 500);
    for (const id of committed.keys()) if (!seen.has(id)) fail('AUTOMATION_SOURCE_CORRUPT', 'Committed automation source transaction is missing.', 500);
    await rm(join(this.#root, 'transactions.json'), { force: true }).catch(() => {});
    return Object.freeze({ kind: 'source', scanned: names.length, recovered, removed, legacyPreserved });
  }

  async discardCreated(source) {
    if (!this.#created.has(source)) return false;
    const record = await this.#readRecord(source.id);
    if (record.sha256 !== source.sha256 || record.size !== source.size) {
      fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source cleanup binding is invalid.', 500);
    }
    const handle = await this.#openSource(record);
    await handle.close();
    await rm(join(this.#root, record.id), { recursive: true });
    await syncDirectory(this.#root);
    const journal = await readTransactionJournal(this.#root, 'source');
    const remaining = journal.filter((entry) => entry.ref.id !== record.id);
    if (remaining.length) await writePrivateJson(join(this.#root, 'transactions.json'), { version: TRANSACTION_VERSION, transactions: remaining });
    else await rm(join(this.#root, 'transactions.json'), { force: true }).catch(() => {});
    this.#created.delete(source);
    return true;
  }

  async #createSource(store, documentId, document, signal) {
    const id = this.#idFactory();
    if (!OPAQUE_ID.test(id)) fail('INVALID_AUTOMATION_SOURCE_ID', 'Automation source ID is unsafe.', 500);
    const directory = join(this.#root, id);
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
      const ref = transactionReference('source', { id, sha256: document.sha256, size: document.size });
      await writePrivateJson(join(directory, 'transaction.json'), { version: TRANSACTION_VERSION, state: 'staged', ref });
      await stagePrivateSourceCopy({
        sourcePath: store.getSourcePath(documentId), targetPath: join(directory, 'source.pdf'),
        expectedSha256: document.sha256, expectedSize: document.size,
        maximumBytes: MAX_SOURCE_BYTES, signal,
      });
      throwIfAborted(signal);
      await store.verifySource(documentId);
      throwIfAborted(signal);
      const record = {
        version: SOURCE_RECORD_VERSION, id, sha256: document.sha256, size: document.size,
      };
      const handle = await open(
        join(directory, 'record.json'),
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
        await handle.chmod(0o400);
      } finally { await handle.close(); }
      await syncDirectory(directory);
      await syncDirectory(this.#root);
      const journal = await readTransactionJournal(this.#root, 'source');
      await writePrivateJson(join(this.#root, 'transactions.json'), { version: TRANSACTION_VERSION, transactions: [...journal.filter((entry) => entry.ref.id !== id), { version: TRANSACTION_VERSION, state: 'staged', ref }] });
      const createdSource = sourceRecord(Buffer.from(JSON.stringify(record)));
      this.#created.add(createdSource);
      return createdSource;
    } catch (error) {
      if (created) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        await syncDirectory(this.#root).catch(() => {});
      }
      if (error?.code === 'EEXIST') {
        fail('INVALID_AUTOMATION_SOURCE_ID', 'Automation source ID already exists.', 500, error);
      }
      throw error;
    }
  }

  async #setTransactionState(id, state) {
    const record = await this.#readRecord(id);
    const ref = transactionReference('source', record);
    await this.#writeMarker(ref, state);
    const journal = await readTransactionJournal(this.#root, 'source');
    const remaining = journal.filter((entry) => entry.ref.id !== id);
    if (state === 'staged') remaining.push({ version: TRANSACTION_VERSION, state, ref });
    if (remaining.length) await writePrivateJson(join(this.#root, 'transactions.json'), { version: TRANSACTION_VERSION, transactions: remaining });
    else await rm(join(this.#root, 'transactions.json'), { force: true }).catch(() => {});
  }

  async #writeMarker(ref, state) {
    await writePrivateJson(join(this.#root, ref.id, 'transaction.json'), { version: TRANSACTION_VERSION, state, ref });
    await syncDirectory(join(this.#root, ref.id));
  }

  async #removeRecord(id) {
    await rm(join(this.#root, id), { recursive: true });
    await syncDirectory(this.#root);
  }

  async #readRecord(id) {
    if (!OPAQUE_ID.test(id)) fail('AUTOMATION_SOURCE_NOT_FOUND', 'Automation source was not found.', 404);
    const directory = join(this.#root, id);
    await existingPrivateDirectory(
      directory, 'AUTOMATION_SOURCE_NOT_FOUND', 'Automation source was not found.',
    );
    const record = sourceRecord(
      await readPrivateFile(join(directory, 'record.json'), MAX_RECORD_BYTES),
    );
    if (record.id !== id) fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source metadata is invalid.', 500);
    return record;
  }

  async #openSource(record) {
    const path = join(this.#root, record.id, 'source.pdf');
    const before = await lstat(path, { bigint: true });
    if (!checkedPrivateFile(before, record.size, MAX_SOURCE_BYTES)) {
      fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source content is unsafe.', 500);
    }
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(before, opened)
        || !checkedPrivateFile(opened, record.size, MAX_SOURCE_BYTES)
        || await digestHandle(handle, record.size) !== record.sha256) {
        fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source content failed verification.', 500);
      }
      const after = await handle.stat({ bigint: true });
      if (!sameIdentity(opened, after)) {
        fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source content changed during verification.', 500);
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async #inventory() {
    const entries = await readdir(this.#root, { withFileTypes: true });
    if (entries.length > MAX_SOURCE_RECORDS) {
      fail('AUTOMATION_SOURCE_QUOTA', 'Automation source storage exceeds its fixed record quota.', 507);
    }
    const records = [];
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.name === 'transactions.json') continue;
      if (!entry.isDirectory() || !OPAQUE_ID.test(entry.name)) {
        fail('AUTOMATION_SOURCE_CORRUPT', 'Automation source storage contains an unsafe entry.', 500);
      }
      const record = await this.#readRecord(entry.name);
      totalBytes += record.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SOURCE_STORE_BYTES) {
        fail('AUTOMATION_SOURCE_QUOTA', 'Automation source storage exceeds its fixed byte quota.', 507);
      }
      records.push(record);
    }
    return Object.freeze({ records: Object.freeze(records), totalBytes });
  }
}
