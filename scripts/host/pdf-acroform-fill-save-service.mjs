import { createDeadline } from './workspace-job-runtime.mjs';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { boundedNfcText } from './pdf-acroform-validation-core.mjs';
import { cleanupAcroFormFillSaveJob, MAX_PDF_ACROFORM_FILL_SAVE_JOB_MS, MAX_PDF_ACROFORM_FILL_SAVE_SOURCE_BYTES, runAcroFormFillSaveJob } from './pdf-acroform-fill-save-job.mjs';
import { PDF_ACROFORM_FILL_SAVE_PROFILE } from './pdf-acroform-fill-save-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace',
  'cleanupJob', 'promotePdfArtifact', 'deleteArtifact',
]);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshot(request) { try { if (!request || isProxy(request) || Object.getPrototypeOf(request) !== Object.prototype || Reflect.ownKeys(request).some((key) => typeof key !== 'string')) throw new Error(); const entries = Object.getOwnPropertyDescriptors(request); if (Object.keys(entries).sort().join(',') !== 'fieldName,profile,sourceSha256,value' || Object.values(entries).some((entry) => !Object.hasOwn(entry, 'value') || entry.enumerable !== true)) throw new Error(); return Object.freeze({ profile: entries.profile.value, sourceSha256: entries.sourceSha256.value, fieldName: entries.fieldName.value, value: entries.value.value }); } catch { throw host('INVALID_ACROFORM_FILL_SAVE_OPTIONS', 'A plain fill/save request with data properties only is required.', 400); } }
export class PdfAcroFormFillSaveService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAcroFormFillSaveService requires a DocumentStore-compatible store.'); this.#store = store; }
  async fill(documentId, request, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const frozen = snapshot(request);
    try {
      boundedNfcText(frozen.fieldName, 'fieldName');
      if (typeof frozen.value !== 'string' && typeof frozen.value !== 'boolean') throw new Error();
      if (typeof frozen.value === 'string') boundedNfcText(frozen.value, 'value', { minimum: 0, maximum: 2000 });
    } catch { throw host('INVALID_ACROFORM_FILL_SAVE_OPTIONS', 'The fill/save field name or value is invalid.', 400); }
    if (frozen.profile !== PDF_ACROFORM_FILL_SAVE_PROFILE || !SHA256.test(String(frozen.sourceSha256 ?? ''))) throw host('INVALID_ACROFORM_FILL_SAVE_OPTIONS', 'A supported profile and lowercase source digest are required.', 400);
    const source = this.#store.getDocument(documentId);
    if (source.sha256 !== frozen.sourceSha256) throw host('SOURCE_VERSION_MISMATCH', 'The fill/save source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_ACROFORM_FILL_SAVE_SOURCE_BYTES) throw host('ACROFORM_FILL_SAVE_INPUT_TOO_LARGE', 'The fill/save source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_FILL_SAVE_JOB_MS);
    const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runAcroFormFillSaveJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle }); }
    catch (error) {
      if (deadline.timedOut) throw host('ACROFORM_FILL_SAVE_TIMEOUT', 'AcroForm fill/save processing exceeded its deadline.', 504, error);
      if (signal?.aborted || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'AcroForm fill/save processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_FILL_SAVE_SOURCE') throw host('ACROFORM_FILL_SAVE_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive AcroForm fill/save subset.', 422, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_FILL_SAVE') throw host('INVALID_ACROFORM_FILL_SAVE_OPTIONS', 'The AcroForm fill/save request is invalid.', 400, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_FILL_SAVE_OUTPUT') throw host('ACROFORM_FILL_SAVE_OUTPUT_INVALID', 'Independent fill/save inspection rejected the output.', 502, error);
      throw host('ACROFORM_FILL_SAVE_FAILED', 'The local host could not create a verified filled form.', 502, error);
    } finally { deadline.dispose(); await cleanupAcroFormFillSaveJob({ store: this.#store, lifecycle }); }
  }
}
export const AcroFormFillSaveService = PdfAcroFormFillSaveService;
