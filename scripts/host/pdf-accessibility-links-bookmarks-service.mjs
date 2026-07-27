import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { normalizePdfAccessibilityLinksBookmarks } from './pdf-accessibility-links-bookmarks-contract.mjs';
import { inspectPdfAccessibilityLinksBookmarks, writePdfAccessibilityLinksBookmarks } from './pdf-accessibility-links-bookmarks-writer.mjs';
import { runAccessibilityLinksBookmarksJob } from './pdf-accessibility-links-bookmarks-job.mjs';
import { MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES } from './pdf-accessibility-links-bookmarks-validation.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const STORE_METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE_METHODS = Object.freeze(['normalizePdfAccessibilityLinksBookmarks', 'writePdfAccessibilityLinksBookmarks', 'inspectPdfAccessibilityLinksBookmarks']);
const DEFAULT_CORE = Object.freeze({ normalizePdfAccessibilityLinksBookmarks, writePdfAccessibilityLinksBookmarks, inspectPdfAccessibilityLinksBookmarks });
const MAX_JOB_MS = 120_000;

function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function cleanupFailure(store, lifecycle) { return Promise.allSettled(lifecycle.workspaces.reverse().map((path) => Promise.resolve().then(() => store.cleanupJob(path)))).then(async (results) => { const workspaceFailed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false; if ((!lifecycle.completed || workspaceFailed) && lifecycle.promotedArtifact?.artifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; } } if (workspaceFailed || artifactFailed) throw host('ACCESSIBILITY_LINKS_BOOKMARKS_CLEANUP_FAILED', 'Accessibility links/bookmarks processing could not clean its private workspace or artifact.', 500); }); }

export class PdfAccessibilityLinksBookmarksService {
  #store; #core;
  constructor({ store, core = DEFAULT_CORE } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfAccessibilityLinksBookmarksService requires a DocumentStore-compatible store.');
    if (!core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) throw new TypeError('PdfAccessibilityLinksBookmarksService requires the fixed raw links/bookmarks core API.');
    this.#store = store; this.#core = core;
  }
  async update(documentId, value, { sourceSha256, signal: externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request; try { request = this.#core.normalizePdfAccessibilityLinksBookmarks(value); } catch (error) { throw host('INVALID_ACCESSIBILITY_LINKS_BOOKMARKS_OPTIONS', 'The requested accessibility links/bookmarks repair is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256 || request.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The accessibility links/bookmarks source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_BYTES) throw host('ACCESSIBILITY_LINKS_BOOKMARKS_INPUT_TOO_LARGE', 'Accessibility links/bookmarks editing is limited to non-empty 128 MiB documents.', 413);
    const deadline = createDeadline(externalSignal, MAX_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
    try { return await runAccessibilityLinksBookmarksJob({ store: this.#store, core: this.#core, documentId, source, request, deadline, lifecycle }); }
    catch (error) {
      if (deadline.timedOut) throw host('ACCESSIBILITY_LINKS_BOOKMARKS_TIMEOUT', 'Accessibility links/bookmarks processing exceeded its two-minute deadline.', 504, error);
      if (externalSignal?.aborted) throw host('JOB_CANCELLED', 'Accessibility links/bookmarks processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS') throw host('INVALID_ACCESSIBILITY_LINKS_BOOKMARKS_OPTIONS', 'The requested accessibility links/bookmarks repair is invalid.', 400, error);
      if (error?.code === 'UNSUPPORTED_ACCESSIBILITY_LINKS_BOOKMARKS_PDF') throw host('ACCESSIBILITY_LINKS_BOOKMARKS_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded accessibility links/bookmarks subset.', 422, error);
      if (error?.code === 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT' || error?.code === 'ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID') throw host('ACCESSIBILITY_LINKS_BOOKMARKS_OUTPUT_INVALID', 'The append-only links/bookmarks output failed separate raw reinspection.', 502, error);
      throw host('ACCESSIBILITY_LINKS_BOOKMARKS_FAILED', 'The local host could not create a verified append-only links/bookmarks copy.', 502, error);
    } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanupFailure(this.#store, lifecycle); }
  }
}

export function createPdfAccessibilityLinksBookmarksService(options) { return new PdfAccessibilityLinksBookmarksService(options); }
