import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { createPdfkitRequestPath } from './adapters/pdfkit.mjs';

export const DEFAULT_PDFKIT_INSPECTION_LIMITS = Object.freeze({
  maxPages: 100,
  maxAnnotationsPerPage: 50,
  maxWidgetsPerPage: 50,
  maxOutlineDepth: 8,
  maxOutlineItems: 200,
  timeoutMs: 30_000,
});

const EXPECTED_WORKSPACE_FILES = Object.freeze(['input.pdf', 'request.json']);

function cancelled(signal) {
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'The local PDFKit inspection was cancelled.', 499);
}

function checkedLimits(configured = {}) {
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)
    || Object.keys(configured).some((key) => !Object.hasOwn(DEFAULT_PDFKIT_INSPECTION_LIMITS, key))) {
    throw new TypeError('PDFKit inspection limits are invalid.');
  }
  const limits = { ...DEFAULT_PDFKIT_INSPECTION_LIMITS, ...configured };
  for (const [key, maximum] of Object.entries(DEFAULT_PDFKIT_INSPECTION_LIMITS)) {
    const minimum = ['maxAnnotationsPerPage', 'maxWidgetsPerPage', 'maxOutlineDepth', 'maxOutlineItems'].includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > maximum) {
      throw new TypeError('PDFKit inspection limits must not exceed the fixed local bounds.');
    }
  }
  return Object.freeze(limits);
}

function requestJson(limits) {
  return JSON.stringify({
    version: 1,
    operation: 'inspect',
    inputFilename: 'input.pdf',
    limits: {
      maxPages: limits.maxPages,
      maxAnnotationsPerPage: limits.maxAnnotationsPerPage,
      maxWidgetsPerPage: limits.maxWidgetsPerPage,
      maxOutlineDepth: limits.maxOutlineDepth,
      maxOutlineItems: limits.maxOutlineItems,
    },
  });
}

async function writePrivateRequest(path, contents) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o400);
}

async function assertWorkspace(workspace) {
  const entries = (await readdir(workspace)).sort();
  if (entries.length !== EXPECTED_WORKSPACE_FILES.length
    || entries.some((entry, index) => entry !== EXPECTED_WORKSPACE_FILES[index])) {
    throw new HostError('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper changed its private read-only workspace.', 502);
  }
  for (const entry of entries) {
    const metadata = await lstat(join(workspace, entry));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      throw new HostError('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper workspace contains an unsafe file.', 502);
    }
  }
}

function freezeResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeResult(item);
  return Object.freeze(value);
}

export class PdfKitInspectionService {
  #store; #pdf; #adapter; #limits;

  constructor({ store, pdfService, adapter, limits } = {}) {
    if (!store || !['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob'].every((name) => typeof store[name] === 'function')) {
      throw new TypeError('PdfKitInspectionService requires a DocumentStore-compatible store.');
    }
    if (!pdfService || typeof pdfService.inspect !== 'function') throw new TypeError('PdfKitInspectionService requires Poppler inspection.');
    if (!adapter || typeof adapter.inspect !== 'function') throw new TypeError('PdfKitInspectionService requires a PDFKit adapter.');
    this.#store = store;
    this.#pdf = pdfService;
    this.#adapter = adapter;
    this.#limits = checkedLimits(limits);
  }

  async inspect(documentId, { signal } = {}) {
    cancelled(signal);
    const source = this.#store.getDocument(documentId);
    await this.#store.verifySource(documentId);
    const workspace = await this.#store.createJobWorkspace(documentId);
    const inputPath = join(workspace, 'input.pdf');
    const requestPath = createPdfkitRequestPath(workspace);
    try {
      await copyFile(this.#store.getSourcePath(documentId), inputPath, fsConstants.COPYFILE_EXCL);
      await chmod(inputPath, 0o400);
      if (await digestFile(inputPath) !== source.sha256) throw new HostError('SOURCE_INTEGRITY_FAILED', 'The private PDFKit source copy does not match the immutable document.', 500);
      const request = requestJson(this.#limits);
      await writePrivateRequest(requestPath, request);
      const requestDigest = createHash('sha256').update(request).digest('hex');
      await assertWorkspace(workspace);
      const poppler = await this.#pdf.inspect(documentId, { signal });
      const result = await this.#adapter.inspect({ workspacePath: workspace, requestPath }, { signal, timeoutMs: this.#limits.timeoutMs });
      cancelled(signal);
      await assertWorkspace(workspace);
      if (await digestFile(inputPath) !== source.sha256 || await digestFile(requestPath) !== requestDigest) {
        throw new HostError('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper changed its read-only inputs.', 502);
      }
      if (!Number.isSafeInteger(poppler?.pageCount) || result?.document?.pageCount !== poppler.pageCount) {
        throw new HostError('PDFKIT_PAGE_COUNT_MISMATCH', 'PDFKit and Poppler did not agree on the document page count.', 502);
      }
      await this.#store.verifySource(documentId);
      return freezeResult({
        kind: 'pdfkit-structure-inspection',
        sourceDigest: source.sha256,
        pageCount: poppler.pageCount,
        document: result.document,
        metadata: result.metadata,
        pages: result.pages,
        pagesTruncated: result.pagesTruncated,
        outline: result.outline,
        pageLabels: result.pageLabels,
        optionalContent: result.optionalContent,
        evidence: {
          engine: 'Apple PDFKit',
          operationMode: 'inventory-only',
          helperBinaryDigestVerified: true,
          descriptorBackedInput: true,
          privateInputsUnchanged: true,
          sourceDigestReverified: true,
          workspaceContentsUnchanged: true,
          popplerPageCountMatched: true,
          activeActionsNotExecuted: true,
          optionalContentCatalogReadOnly: true,
        },
        limitations: [
          'Resolved page-box bounds do not prove whether inherited boxes were explicitly present.',
          'Only outline destinations that PDFKit resolves to pages are navigable; unsupported actions remain unresolved labels.',
          'Link actions are inventoried but never executed; unsupported actions remain unresolved and external targets are inert text.',
          'Logical labels are PDFKit-resolved values; optional-content groups are catalog inventory only and cannot be toggled or edited.',
          'Widget values are omitted; XFA, tag semantics, arbitrary objects, and mutation are not inspected.',
          'This does not claim byte/object preservation, signature retention, conformance, or safe rewriting.',
        ],
      });
    } catch (error) {
      if (error instanceof HostError) throw error;
      if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'The local PDFKit inspection was cancelled.', 499, { cause: error });
      if (error?.code === 'UNREADABLE_DOCUMENT') {
        throw new HostError('PDFKIT_DOCUMENT_UNSUPPORTED', 'The optional local PDFKit helper could not read this PDF.', 422, { cause: error });
      }
      throw new HostError('PDFKIT_INSPECTION_FAILED', 'The optional local PDFKit inspection failed.', 502, { cause: error });
    } finally {
      await this.#store.cleanupJob(workspace);
    }
  }
}
