import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from '../host-error.mjs';
import { stagePrivateSourceCopy } from '../private-source-copy.mjs';
import {
  checkedPrivateFile, digestHandle, existingPrivateDirectory, fail,
  MAX_OUTPUT_BYTES, MAX_OUTPUT_RECORDS, MAX_OUTPUT_STORE_BYTES, MAX_RECORD_BYTES,
  OPAQUE_ID, OUTPUT_RECORD_VERSION, outputRecord, readPrivateFile, sameIdentity,
  SHA256, syncDirectory, throwIfAborted,
  readTransactionJournal, transactionMarker,
  transactionReference, writePrivateJson, TRANSACTION_VERSION, sameTransactionReference,
} from './automation-store-support.mjs';

export class AutomationOutputRecordStore {
  #root; #idFactory; #created = new WeakSet(); #pendingIds = new Set(); #committing = new Set();

  constructor({ root, idFactory }) {
    this.#root = root;
    this.#idFactory = idFactory;
  }

  async stagePromotedArtifact({ store, artifactId, source, signal } = {}) {
    if (!store || typeof store.getArtifact !== 'function'
      || !OPAQUE_ID.test(artifactId ?? '')
      || !source || !OPAQUE_ID.test(source.id) || !SHA256.test(source.sha256)
      || (signal !== undefined && (signal === null || typeof signal !== 'object'
        || typeof signal.aborted !== 'boolean'))) {
      fail('INVALID_AUTOMATION_OUTPUT', 'Automation output staging requires one promoted PDF artifact.');
    }
    throwIfAborted(signal);
    const artifact = store.getArtifact(artifactId);
    if (artifact.id !== artifactId || artifact.mediaType !== 'application/pdf'
      || !SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.size)
      || artifact.size < 5 || artifact.size > MAX_OUTPUT_BYTES
      || typeof artifact.filePath !== 'string' || !artifact.filePath.startsWith('/')) {
      fail('INVALID_AUTOMATION_OUTPUT', 'Automation output exceeds the durable output policy.');
    }
    const inventory = await this.#inventory();
    if (inventory.records.length >= MAX_OUTPUT_RECORDS
      || inventory.totalBytes + artifact.size > MAX_OUTPUT_STORE_BYTES) {
      fail('AUTOMATION_OUTPUT_QUOTA', 'Automation output storage has reached its fixed quota.', 507);
    }
    return this.#createOutput(store, artifact, source, signal);
  }
  async openVerified(id, expectedSha256) {
    if (!OPAQUE_ID.test(id) || !SHA256.test(expectedSha256)) {
      fail('AUTOMATION_OUTPUT_NOT_FOUND', 'Automation output was not found.', 404);
    }
    if (this.#pendingIds.has(id) || this.#committing.has(id)) {
      fail('AUTOMATION_OUTPUT_NOT_FOUND', 'Automation output was not found.', 404);
    }
    const record = await this.#readRecord(id);
    if (record.sha256 !== expectedSha256) {
      fail('AUTOMATION_OUTPUT_MISMATCH', 'Automation output digest does not match its receipt.', 409);
    }
    const handle = await this.#openOutput(record);
    const stream = handle.createReadStream({ autoClose: true, start: 0, end: record.size - 1 });
    return Object.freeze({ ...record, stream });
  }
  async list() {
    const inventory = await this.#inventory();
    return Object.freeze(inventory.records
      .filter((record) => !this.#pendingIds.has(record.id) && !this.#committing.has(record.id))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => Object.freeze({ ...record })));
  }
  async getMetadata(id) {
    if (this.#pendingIds.has(id) || this.#committing.has(id)) {
      fail('AUTOMATION_OUTPUT_NOT_FOUND', 'Automation output was not found.', 404);
    }
    const record = await this.#readRecord(id);
    const handle = await this.#openOutput(record);
    await handle.close();
    return Object.freeze({ ...record });
  }
  async delete(id, expectedSha256) {
    if (!OPAQUE_ID.test(id) || !SHA256.test(expectedSha256)) {
      fail('AUTOMATION_OUTPUT_NOT_FOUND', 'Automation output was not found.', 404);
    }
    if (this.#pendingIds.has(id) || this.#committing.has(id)) {
      fail('AUTOMATION_OUTPUT_BUSY', 'Automation output is not yet committed.', 409);
    }
    const record = await this.#readRecord(id);
    if (record.sha256 !== expectedSha256) {
      fail('AUTOMATION_OUTPUT_MISMATCH', 'Automation output digest confirmation failed.', 409);
    }
    const handle = await this.#openOutput(record);
    try {
      const opened = await handle.stat({ bigint: true });
      const pathMetadata = await lstat(join(this.#root, record.id, 'output.pdf'), { bigint: true });
      if (!sameIdentity(opened, pathMetadata)
        || !checkedPrivateFile(pathMetadata, record.size, MAX_OUTPUT_BYTES)) {
        fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output changed before deletion.', 500);
      }
      const confirmed = await this.#readRecord(record.id);
      if (confirmed.sha256 !== record.sha256 || confirmed.size !== record.size
        || confirmed.sourceId !== record.sourceId
        || confirmed.sourceSha256 !== record.sourceSha256) {
        fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output metadata changed before deletion.', 500);
      }
      await rm(join(this.#root, record.id), { recursive: true });
      await syncDirectory(this.#root);
    } catch (error) {
      if (error instanceof HostError) throw error;
      fail('AUTOMATION_OUTPUT_DELETE_FAILED', 'Automation output could not be deleted safely.', 500, error);
    } finally { await handle.close().catch(() => {}); }
    return Object.freeze({ ...record });
  }
  commit(output) {
    this.#committing.add(output.id);
    return this.#setTransactionState(output.id, 'committed').then(() => { this.#created.delete(output); this.#pendingIds.delete(output.id); this.#committing.delete(output.id); }, (error) => { this.#committing.delete(output.id); throw error; });
  }
  async recoverTransactions(references = {}) {
    const committed = new Map((references.committed ?? []).filter((ref) => ref?.kind === 'output').map((ref) => [ref.id, ref]));
    const discard = new Map((references.discard ?? []).filter((ref) => ref?.kind === 'output').map((ref) => [ref.id, ref]));
    const journal = await readTransactionJournal(this.#root, 'output');
    const names = await readdir(this.#root, { withFileTypes: true });
    let recovered = 0; let removed = 0; let legacyPreserved = 0;
    const seen = new Set(); const present = new Set();
    for (const entry of names) {
      if (entry.name === 'transactions.json') continue;
      if (!entry.isDirectory() || !OPAQUE_ID.test(entry.name)) fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output storage contains an unsafe entry.', 500);
      const record = await this.#readRecord(entry.name);
      const children = await readdir(join(this.#root, entry.name), { withFileTypes: true });
      let marker;
      try { marker = transactionMarker(await readPrivateFile(join(this.#root, entry.name, 'transaction.json'), MAX_RECORD_BYTES), 'output'); }
      catch (error) {
        if (error?.code === 'ENOENT') {
          if (children.length !== 2 || children.some((child) => !['record.json', 'output.pdf'].includes(child.name) || !child.isFile())) fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output record contains an unexpected entry.', 500);
          legacyPreserved += 1; continue;
        }
        throw error;
      }
      if (children.length !== 3 || children.some((child) => !['record.json', 'output.pdf', 'transaction.json'].includes(child.name) || !child.isFile())) fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output transaction contains an unexpected entry.', 500);
      const ref = transactionReference('output', record);
      present.add(record.id);
      if (!sameTransactionReference(marker.ref, ref)) fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output transaction binding is invalid.', 500);
      const wanted = committed.get(record.id);
      const doomed = discard.get(record.id);
      if (wanted && !sameTransactionReference(wanted, ref)) fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output committed transaction does not match the record.', 500);
      if (wanted) seen.add(record.id);
      if (doomed && !sameTransactionReference(doomed, ref)) {
        fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output discard transaction does not match the record.', 500);
      } else if (doomed) {
        const handle = await this.#openOutput(record); await handle.close();
        await this.#removeRecord(record.id); removed += 1;
      } else if (marker.state === 'staged' && wanted && sameTransactionReference(wanted, ref)) {
        await this.#writeMarker(ref, 'committed'); recovered += 1;
      } else if (marker.state === 'staged' && !wanted) {
        const handle = await this.#openOutput(record); await handle.close();
        await this.#removeRecord(record.id); removed += 1;
      }
    }
    for (const entry of journal) if (!present.has(entry.ref.id)
      && (!discard.has(entry.ref.id) || !sameTransactionReference(discard.get(entry.ref.id), entry.ref))) fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output transaction journal is not reconciled.', 500);
    for (const id of committed.keys()) if (!seen.has(id)) fail('AUTOMATION_OUTPUT_CORRUPT', 'Committed automation output transaction is missing.', 500);
    await rm(join(this.#root, 'transactions.json'), { force: true }).catch(() => {});
    this.#pendingIds.clear(); this.#committing.clear();
    return Object.freeze({ kind: 'output', scanned: names.length, recovered, removed, legacyPreserved });
  }
  async discardCreated(output) {
    if (!this.#created.has(output)) return false;
    const record = await this.#readRecord(output.id);
    if (record.sha256 !== output.sha256 || record.size !== output.size
      || record.sourceId !== output.sourceId || record.sourceSha256 !== output.sourceSha256) {
      fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output cleanup binding is invalid.', 500);
    }
    const handle = await this.#openOutput(record);
    await handle.close();
    await rm(join(this.#root, record.id), { recursive: true });
    await syncDirectory(this.#root);
    const journal = await readTransactionJournal(this.#root, 'output');
    const remaining = journal.filter((entry) => entry.ref.id !== record.id);
    if (remaining.length) await writePrivateJson(join(this.#root, 'transactions.json'), { version: TRANSACTION_VERSION, transactions: remaining });
    else await rm(join(this.#root, 'transactions.json'), { force: true }).catch(() => {});
    this.#created.delete(output);
    this.#pendingIds.delete(output.id);
    return true;
  }
  async #createOutput(store, artifact, source, signal) {
    const id = this.#idFactory();
    if (!OPAQUE_ID.test(id)) fail('INVALID_AUTOMATION_OUTPUT_ID', 'Automation output ID is unsafe.', 500);
    const directory = join(this.#root, id);
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
      const ref = transactionReference('output', {
        id, sha256: artifact.sha256, size: artifact.size,
        sourceId: source.id, sourceSha256: source.sha256,
      });
      await writePrivateJson(join(directory, 'transaction.json'), { version: TRANSACTION_VERSION, state: 'staged', ref });
      await stagePrivateSourceCopy({
        sourcePath: artifact.filePath, targetPath: join(directory, 'output.pdf'),
        expectedSha256: artifact.sha256, expectedSize: artifact.size,
        maximumBytes: MAX_OUTPUT_BYTES, signal,
      });
      throwIfAborted(signal);
      const current = store.getArtifact(artifact.id);
      if (current.id !== artifact.id || current.mediaType !== 'application/pdf'
        || current.filePath !== artifact.filePath || current.sha256 !== artifact.sha256
        || current.size !== artifact.size || current.documentId !== artifact.documentId) {
        fail('AUTOMATION_OUTPUT_MISMATCH', 'The promoted artifact changed during durable staging.', 409);
      }
      throwIfAborted(signal);
      const record = {
        version: OUTPUT_RECORD_VERSION, id, sha256: artifact.sha256, size: artifact.size,
        sourceId: source.id, sourceSha256: source.sha256,
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
      const journal = await readTransactionJournal(this.#root, 'output');
      await writePrivateJson(join(this.#root, 'transactions.json'), { version: TRANSACTION_VERSION, transactions: [...journal.filter((entry) => entry.ref.id !== id), { version: TRANSACTION_VERSION, state: 'staged', ref }] });
      const createdOutput = outputRecord(Buffer.from(JSON.stringify(record)));
      this.#created.add(createdOutput);
      this.#pendingIds.add(createdOutput.id);
      return createdOutput;
    } catch (error) {
      if (created) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        await syncDirectory(this.#root).catch(() => {});
      }
      if (error?.code === 'EEXIST') {
        fail('INVALID_AUTOMATION_OUTPUT_ID', 'Automation output ID already exists.', 500, error);
      }
      throw error;
    }
  }
  async #setTransactionState(id, state) {
    const record = await this.#readRecord(id); const ref = transactionReference('output', record); await this.#writeMarker(ref, state);
    const journal = await readTransactionJournal(this.#root, 'output'); const remaining = journal.filter((entry) => entry.ref.id !== id);
    if (state === 'staged') remaining.push({ version: TRANSACTION_VERSION, state, ref });
    if (remaining.length) await writePrivateJson(join(this.#root, 'transactions.json'), { version: TRANSACTION_VERSION, transactions: remaining }); else await rm(join(this.#root, 'transactions.json'), { force: true }).catch(() => {});
  }
  async #writeMarker(ref, state) { await writePrivateJson(join(this.#root, ref.id, 'transaction.json'), { version: TRANSACTION_VERSION, state, ref }); await syncDirectory(join(this.#root, ref.id)); }
  async #removeRecord(id) { await rm(join(this.#root, id), { recursive: true }); await syncDirectory(this.#root); }
  async #readRecord(id) {
    if (!OPAQUE_ID.test(id)) fail('AUTOMATION_OUTPUT_NOT_FOUND', 'Automation output was not found.', 404); const directory = join(this.#root, id);
    await existingPrivateDirectory(directory, 'AUTOMATION_OUTPUT_NOT_FOUND', 'Automation output was not found.');
    const record = outputRecord(await readPrivateFile(join(directory, 'record.json'), MAX_RECORD_BYTES, { corruptCode: 'AUTOMATION_OUTPUT_CORRUPT', corruptLabel: 'Automation output metadata' }));
    if (record.id !== id) fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output metadata is invalid.', 500);
    return record; }
  async #openOutput(record) {
    const path = join(this.#root, record.id, 'output.pdf');
    let before;
    try { before = await lstat(path, { bigint: true }); } catch (error) {
      fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output content is unavailable.', 500, error);
    }
    if (!checkedPrivateFile(before, record.size, MAX_OUTPUT_BYTES)) {
      fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output content is unsafe.', 500);
    }
    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(before, opened)
        || !checkedPrivateFile(opened, record.size, MAX_OUTPUT_BYTES)
        || await digestHandle(handle, record.size) !== record.sha256) {
        fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output content failed verification.', 500);
      }
      const after = await handle.stat({ bigint: true });
      if (!sameIdentity(opened, after)) {
        fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output content changed during verification.', 500);
      }
      return handle;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof HostError) throw error;
      fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output content could not be opened safely.', 500, error);
    }
  }
  async #inventory() {
    const entries = await readdir(this.#root, { withFileTypes: true });
    if (entries.length > MAX_OUTPUT_RECORDS) {
      fail('AUTOMATION_OUTPUT_QUOTA', 'Automation output storage exceeds its fixed record quota.', 507);
    }
    const records = [];
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.name === 'transactions.json') continue;
      if (!entry.isDirectory() || !OPAQUE_ID.test(entry.name)) {
        fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output storage contains an unsafe entry.', 500);
      }
      const record = await this.#readRecord(entry.name);
      let metadata;
      try { metadata = await lstat(join(this.#root, record.id, 'output.pdf'), { bigint: true }); }
      catch (error) {
        fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output content is unavailable.', 500, error);
      }
      if (!checkedPrivateFile(metadata, record.size, MAX_OUTPUT_BYTES)) {
        fail('AUTOMATION_OUTPUT_CORRUPT', 'Automation output content is unsafe.', 500);
      }
      totalBytes += record.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_OUTPUT_STORE_BYTES) {
        fail('AUTOMATION_OUTPUT_QUOTA', 'Automation output storage exceeds its fixed byte quota.', 507);
      }
      records.push(record);
    }
    return Object.freeze({ records: Object.freeze(records), totalBytes });
  }
}
