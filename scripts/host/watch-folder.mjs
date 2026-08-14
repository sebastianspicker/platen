import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HostError } from './host-error.mjs';

export const DEFAULT_WATCH_LIMITS = Object.freeze({ maxEntries: 256, maxPdfFiles: 64 });

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export async function canonicalWatchDirectory(path) {
  const requested = resolve(String(path ?? ''));
  const metadata = await lstat(requested).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail('WATCH_DIRECTORY_INVALID', 'The watch input must be an existing non-symlink directory.');
  return realpath(requested);
}

function signature(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}

export async function snapshotPdfDirectory(directory, limits = {}) {
  const configured = Object.freeze({ ...DEFAULT_WATCH_LIMITS, ...limits });
  if (!Number.isSafeInteger(configured.maxEntries) || configured.maxEntries < 1 || configured.maxEntries > DEFAULT_WATCH_LIMITS.maxEntries
    || !Number.isSafeInteger(configured.maxPdfFiles) || configured.maxPdfFiles < 1 || configured.maxPdfFiles > DEFAULT_WATCH_LIMITS.maxPdfFiles) {
    fail('WATCH_LIMITS_INVALID', 'Watch limits must stay within the fixed local maxima.');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > configured.maxEntries) fail('WATCH_DIRECTORY_LIMIT', `The watch directory may contain at most ${configured.maxEntries} direct entries.`, 413);
  const pdfEntries = entries.filter(({ name }) => name.toLowerCase().endsWith('.pdf')).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (pdfEntries.length > configured.maxPdfFiles) fail('WATCH_DIRECTORY_LIMIT', `The watch directory may contain at most ${configured.maxPdfFiles} direct PDF files.`, 413);
  const records = [];
  for (const entry of pdfEntries) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail('WATCH_INPUT_INVALID', `Watch candidate ${entry.name} must be a non-symlink regular file.`);
    records.push(Object.freeze({ name: entry.name, path, size: metadata.size, signature: signature(metadata) }));
  }
  return Object.freeze(records);
}

export function stablePdfCandidates(previous, current, processed = new Map(), maximum = DEFAULT_WATCH_LIMITS.maxPdfFiles) {
  if (!Array.isArray(previous) || !Array.isArray(current) || !(processed instanceof Map)
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_WATCH_LIMITS.maxPdfFiles) {
    fail('WATCH_STATE_INVALID', 'Watch stability state is invalid.', 500);
  }
  const before = new Map(previous.map((record) => [record.name, record.signature]));
  return Object.freeze(current.filter((record) => before.get(record.name) === record.signature && processed.get(record.name) !== record.signature).slice(0, maximum));
}

export function pruneWatchState(processed, current) {
  const names = new Set(current.map(({ name }) => name));
  for (const name of processed.keys()) if (!names.has(name)) processed.delete(name);
  return processed;
}
