import {
  createDeadline,
  createWorkspaceQuotaMonitor,
  mapEngineError,
  parseTesseractLanguages,
} from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { normalizeOcrUserDictionary } from '../../src/core/ocr-contract.js';
import { lstat, stat, writeFile } from 'node:fs/promises';

export class OcrJobLock {
  #active = false;

  async run(work) {
    if (this.#active) throw new HostError('OCR_BUSY', 'Another local OCR job is already running.', 409);
    this.#active = true;
    try {
      return await work();
    } finally {
      this.#active = false;
    }
  }
}

export async function ocrLanguages(ocrAdapter, { signal } = {}) {
  if (!ocrAdapter) throw new HostError('ENGINE_UNAVAILABLE', 'The local OCR engine is unavailable.', 503);
  try {
    const result = await ocrAdapter.execute('listLanguages', {}, {
      signal,
      timeoutMs: 10_000,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 128 * 1024,
    });
    const languages = parseTesseractLanguages(`${result.stdout}\n${result.stderr}`);
    if (!languages.length) throw new HostError('INVALID_ENGINE_OUTPUT', 'Tesseract did not report any installed languages.', 502);
    return languages;
  } catch (error) {
    throw mapEngineError(error);
  }
}

export function validateOcrLanguage(language, languages) {
  const requestedLanguages = String(language).split('+');
  if (!requestedLanguages.length || requestedLanguages.some((item) => !languages.includes(item))) {
    throw new HostError('OCR_LANGUAGE_UNAVAILABLE', 'Choose only locally installed OCR languages.', 400);
  }
}

export async function createOcrUserDictionary(workspace, terms) {
  if (!Array.isArray(terms) || !terms.length) return null;
  if (typeof workspace !== 'string') {
    throw new HostError('OCR_USER_DICTIONARY_WORKSPACE_INVALID', 'OCR user dictionary storage is unavailable.', 500);
  }
  const workspacePath = resolve(workspace);
  const workspaceStats = await lstat(workspacePath).catch((error) => {
    throw new HostError('OCR_USER_DICTIONARY_WORKSPACE_UNREACHABLE', 'OCR user dictionary storage is unavailable.', 500, { cause: error });
  });
  if (workspaceStats.isSymbolicLink()) {
    throw new HostError('OCR_USER_DICTIONARY_WORKSPACE_INVALID', 'OCR user dictionary storage is unavailable.', 500);
  }
  if (!workspaceStats.isDirectory()) {
    throw new HostError('OCR_USER_DICTIONARY_WORKSPACE_UNAVAILABLE', 'OCR user dictionary storage is unavailable.', 500);
  }
  const normalizedTerms = normalizeOcrUserDictionary(terms);
  if (normalizedTerms.length !== terms.length || normalizedTerms.some((term, index) => term !== terms[index])) {
    const error = new TypeError('OCR user dictionary term is unsafe.');
    error.code = 'OCR_CONTRACT_INVALID';
    throw error;
  }
  const dictionaryFileName = 'ocr-user-words.txt';
  const path = resolve(workspacePath, dictionaryFileName);
  if (basename(path) !== dictionaryFileName || dirname(path) !== workspacePath) {
    throw new HostError('OCR_USER_DICTIONARY_WORKSPACE_INVALID', 'OCR user dictionary storage is unavailable.', 500);
  }
  await stat(path).then(() => {
    throw new HostError('OCR_USER_DICTIONARY_EXISTS', 'An OCR user dictionary already exists for this workspace.', 409);
  }, (error) => {
    if (error.code !== 'ENOENT') {
      throw new HostError('OCR_USER_DICTIONARY_UNACCESSIBLE', 'OCR user dictionary storage is unavailable.', 500, { cause: error });
    }
  });
  const bytes = Buffer.from(`${normalizedTerms.join('\n')}\n`, 'utf8');
  try {
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EISDIR') {
      throw new HostError('OCR_USER_DICTIONARY_EXISTS', 'An OCR user dictionary already exists for this workspace.', 409);
    }
    throw new HostError('OCR_USER_DICTIONARY_UNACCESSIBLE', 'OCR user dictionary storage is unavailable.', 500, { cause: error });
  }
  return Object.freeze({
    path,
    termCount: terms.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  });
}

export function createSearchableOcrProvenance({ documentId, sourceSha256, language, pageCount, cleanupPreset, segmentation, userDictionary, cleanupReceipts, derivedPageCount, recognizedWordCount, suspectCount }) {
  return createOperationProvenance({
    type: 'searchable-ocr',
    inputs: [{ documentId, sha256: sourceSha256, role: 'primary' }],
    parameters: { language, pages: pageCount, rasterized: true, cleanupPreset, segmentation, userDictionary, cleanupReceipts },
    expected: { pageCount, extractableText: true },
    validation: {
      passed: true,
      validators: ['source-sha256', 'pdfinfo-page-count', 'pdftotext-nonempty'],
      pageCount: derivedPageCount,
      recognizedWordCount,
      suspectCount,
    },
  });
}

export async function withOcrWorkspace({ store, documentId, externalSignal, timeoutMessage, timeoutStatus = 504, cancelledMessage, work }) {
  const deadline = createDeadline(externalSignal, 10 * 60_000);
  let workspace = null;
  let quota = null;
  try {
    return await work({
      deadline,
      createWorkspace: async () => {
        workspace = await store.createJobWorkspace(documentId);
        quota = createWorkspaceQuotaMonitor(workspace, deadline);
        return { workspace, quota };
      },
    });
  } catch (error) {
    if (quota?.error) throw quota.error;
    if (deadline.timedOut) throw new HostError('OCR_JOB_TIMEOUT', timeoutMessage, timeoutStatus, { cause: error });
    if (externalSignal?.aborted) throw new HostError('JOB_CANCELLED', cancelledMessage, 499, { cause: error });
    throw mapEngineError(error);
  } finally {
    quota?.stop();
    deadline.dispose();
    if (workspace) await store.cleanupJob(workspace);
  }
}
