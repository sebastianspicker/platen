import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { PDF_SPECIALIST_CONTENT_PROFILE, inspectPdfSpecialistContent } from './pdf-specialist-content-inventory.mjs';
import { normalizePdfSpecialistContent } from './pdf-specialist-content-contract.mjs';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function abort(signal) { if (signal?.aborted) throw host('JOB_CANCELLED', 'Specialist-content inspection was cancelled.', 499, signal.reason); }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }
export const PDF_SPECIALIST_CONTENT_LIMITATIONS = Object.freeze(['Read-only inventory only; no extraction, playback, scripting, authoring, or safety/conformance claim.', 'Payload bytes, names, text, and filesystem paths are omitted from the privacy-minimal result.', 'Malformed, aliased, cyclic, filtered, or resource-ambiguous specialist content is rejected rather than guessed.']);

export class PdfSpecialistContentService {
  #store; #core;
  constructor({ store, core = { inspectPdfSpecialistContent } } = {}) {
    if (!store || !['getDocument', 'getSourcePath', 'verifySource'].every((name) => typeof store[name] === 'function') || !core || typeof core.inspectPdfSpecialistContent !== 'function') throw new TypeError('PdfSpecialistContentService requires a document store and inventory core.');
    this.#store = store; this.#core = core;
  }
  async inspect(documentId, value, { sourceSha256, signal } = {}) {
    abort(signal); let request; try { request = normalizePdfSpecialistContent(value); } catch (error) { throw host('PDF_SPECIALIST_CONTENT_OPTIONS_INVALID', 'Specialist-content options are invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (sourceSha256 !== source.sha256 || request.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The specialist-content source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 32 || source.size > MAX_SOURCE_BYTES) throw host('PDF_SPECIALIST_CONTENT_INPUT_TOO_LARGE', 'Specialist-content inspection is limited to bounded PDF sources.', 413);
    await this.#store.verifySource(documentId); abort(signal);
    let bytes; try { bytes = await readFile(this.#store.getSourcePath(documentId)); } catch (error) { throw host('PDF_SPECIALIST_CONTENT_FAILED', 'The specialist-content source could not be read.', 502, error); }
    if (bytes.length !== source.size || digest(bytes) !== source.sha256) throw host('SOURCE_INTEGRITY_FAILED', 'The specialist-content source digest could not be verified.', 500);
    let inventory; try { inventory = this.#core.inspectPdfSpecialistContent(bytes, request); abort(signal); } catch (error) { if (error?.code === 'UNSUPPORTED_PDF_SPECIALIST_CONTENT') throw host('PDF_SPECIALIST_CONTENT_SOURCE_UNSUPPORTED', 'The PDF is outside the bounded specialist-content inventory subset.', 422, error); if (error?.code === 'INVALID_PDF_SPECIALIST_CONTENT') throw host('PDF_SPECIALIST_CONTENT_OPTIONS_INVALID', 'Specialist-content options are invalid.', 400, error); if (signal?.aborted) throw host('JOB_CANCELLED', 'Specialist-content inspection was cancelled.', 499, error); throw host('PDF_SPECIALIST_CONTENT_FAILED', 'The specialist-content inventory failed.', 502, error); } finally { bytes.fill(0); }
    await this.#store.verifySource(documentId); abort(signal);
    let after; try { after = await readFile(this.#store.getSourcePath(documentId)); } catch (error) { throw host('PDF_SPECIALIST_CONTENT_FAILED', 'The specialist-content source could not be re-read.', 502, error); }
    if (after.length !== source.size || digest(after) !== source.sha256) throw host('SOURCE_INTEGRITY_FAILED', 'The source changed during specialist-content inspection.', 500); after.fill(0);
    return freeze({ ...inventory, profile: PDF_SPECIALIST_CONTENT_PROFILE, sourceSha256: source.sha256, evidence: { ...inventory.evidence, sourceDigestReverified: true, sourceUnchangedDuringExtraction: true }, limitations: PDF_SPECIALIST_CONTENT_LIMITATIONS });
  }
}
