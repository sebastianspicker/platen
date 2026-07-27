import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { HostError } from './host-error.mjs';
import { getDocument } from './document-store-documents.mjs';

export async function initializeStore(state) {
  await mkdir(join(state.root, 'documents'), { recursive: true, mode: 0o700 });
  await mkdir(join(state.root, 'artifacts'), { recursive: true, mode: 0o700 });
  await mkdir(join(state.root, 'jobs'), { recursive: true, mode: 0o700 });
  await chmod(state.root, 0o700);
}

export async function createJobWorkspace(state, documentId) {
  getDocument(state, documentId);
  const directory = await mkdtemp(join(state.root, 'jobs', `${documentId}-`));
  await chmod(directory, 0o700);
  return directory;
}

export async function cleanupJob(state, directory) {
  const target = resolve(directory);
  const jobsRoot = resolve(state.root, 'jobs');
  if (!target.startsWith(`${jobsRoot}${sep}`)) throw new HostError('INVALID_JOB_PATH', 'Refusing to clean a path outside the local job store.', 500);
  await rm(target, { recursive: true, force: true });
}

export async function disposeStore(state) {
  if (state.disposed) return;
  state.disposed = true;
  state.documents.clear();
  state.artifacts.clear();
  await rm(state.root, { recursive: true, force: true });
}
