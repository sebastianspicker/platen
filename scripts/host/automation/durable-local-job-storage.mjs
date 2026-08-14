import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HostError } from '../host-error.mjs';
import { queueFail } from './durable-local-job-record.mjs';

const activeQueueRoots = new Set();

async function assertPrivateQueueRoot(root) {
  const entry = await lstat(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    queueFail('QUEUE_STORAGE_UNSAFE', 'Queue storage must be a private directory.', 500);
  }
}

export async function preparePrivateQueueRoot(root) {
  try {
    await assertPrivateQueueRoot(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertPrivateQueueRoot(root);
  }
  await chmod(root, 0o700);
}

export async function acquirePrivateQueueOwnership(root) {
  if (activeQueueRoots.has(root)) {
    queueFail('QUEUE_ALREADY_OPEN', 'Queue storage already has a live owner.', 409);
  }
  const path = join(root, '.owner.lock');
  let handle;
  let created = false;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    const token = randomUUID();
    const record = JSON.stringify({ pid: process.pid, schemaVersion: 1, token });
    await handle.writeFile(record, 'utf8');
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    await syncDirectory(root);
    activeQueueRoots.add(root);
    return {
      root,
      path,
      handle,
      token,
      dev: metadata.dev,
      ino: metadata.ino,
      released: false,
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await unlink(path).catch(() => {});
    if (error instanceof HostError) throw error;
    if (error?.code === 'EEXIST') {
      queueFail('QUEUE_ALREADY_OPEN', 'Queue storage already has a live owner.', 409);
    }
    queueFail('QUEUE_OWNERSHIP_FAILED', 'Queue storage ownership could not be acquired.', 500, error);
  }
}

export async function assertPrivateQueueOwnership(ownership) {
  if (!ownership || ownership.released || !activeQueueRoots.has(ownership.root)) {
    queueFail('QUEUE_OWNERSHIP_LOST', 'Queue storage ownership is not active.', 500);
  }
  try {
    const [pathMetadata, handleMetadata] = await Promise.all([
      lstat(ownership.path, { bigint: true }),
      ownership.handle.stat({ bigint: true }),
    ]);
    if (pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || pathMetadata.nlink !== 1n
      || pathMetadata.dev !== ownership.dev
      || pathMetadata.ino !== ownership.ino
      || handleMetadata.dev !== ownership.dev
      || handleMetadata.ino !== ownership.ino) {
      queueFail('QUEUE_OWNERSHIP_LOST', 'Queue storage ownership changed.', 500);
    }
  } catch (error) {
    if (error instanceof HostError) throw error;
    queueFail('QUEUE_OWNERSHIP_LOST', 'Queue storage ownership changed.', 500, error);
  }
}

export async function releasePrivateQueueOwnership(ownership) {
  if (!ownership || ownership.released) return;
  try {
    await assertPrivateQueueOwnership(ownership);
    await unlink(ownership.path);
    await syncDirectory(ownership.root);
  } finally {
    ownership.released = true;
    activeQueueRoots.delete(ownership.root);
    await ownership.handle.close().catch(() => {});
  }
}

export async function readPrivateQueueJournal(path, maximumBytes) {
  await assertPrivateQueueRoot(dirname(path));
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    queueFail('QUEUE_STORAGE_UNSAFE', 'Queue journal is not a private regular file.', 500);
  }

  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.nlink !== 1
      || opened.ino !== before.ino
      || opened.dev !== before.dev
      || opened.size > maximumBytes) {
      queueFail('QUEUE_STORAGE_UNSAFE', 'Queue journal changed while being opened.', 500);
    }

    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) {
        queueFail('QUEUE_STORAGE_UNSAFE', 'Queue journal changed while being read.', 500);
      }
      offset += bytesRead;
    }

    const after = await handle.stat();
    if (after.ino !== opened.ino
      || after.dev !== opened.dev
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      queueFail('QUEUE_STORAGE_UNSAFE', 'Queue journal changed while being read.', 500);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  const directory = await open(path, fsConstants.O_RDONLY);
  try {
    await directory.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    await directory.close();
  }
}

export async function writePrivateQueueJournal(path, text, maximumBytes) {
  await assertPrivateQueueRoot(dirname(path));
  if (Buffer.byteLength(text) > maximumBytes) {
    queueFail('QUEUE_JOURNAL_TOO_LARGE', 'Queue journal exceeds its bound.', 500);
  }

  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temp,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    if (error instanceof HostError) throw error;
    queueFail('QUEUE_PERSIST_FAILED', 'Queue journal could not be written durably.', 500, error);
  }
}
