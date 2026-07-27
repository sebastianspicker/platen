import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupAcroFormSignatureFieldJob, MAX_PDF_ACROFORM_SIGNATURE_FIELD_JOB_MS, MAX_PDF_ACROFORM_SIGNATURE_FIELD_SOURCE_BYTES, runAcroFormSignatureFieldJob } from './pdf-acroform-signature-field-job.mjs';
import { PDF_ACROFORM_SIGNATURE_FIELD_PROFILE } from './pdf-acroform-signature-field-writer.mjs';
import { inspectPdfAcroFormSignatureField, preparePdfAcroFormSignatureField } from './pdf-acroform-signature-field-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE = Object.freeze({ preparePdfAcroFormSignatureField, inspectPdfAcroFormSignatureField });
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshot(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype) throw host('INVALID_ACROFORM_SIGNATURE_FIELD_OPTIONS', 'A plain signature-field request is required.', 400);
  const descriptors = Object.getOwnPropertyDescriptors(request); const keys = Reflect.ownKeys(request);
  if (keys.some((key) => typeof key !== 'string') || Object.keys(descriptors).sort().join(',') !== 'fieldName,page,profile,rect,sourceSha256' || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('INVALID_ACROFORM_SIGNATURE_FIELD_OPTIONS', 'The signature-field request contains unsupported fields or accessors.', 400);
  const rect = request.rect; if (!rect || typeof rect !== 'object' || Array.isArray(rect) || Object.getPrototypeOf(rect) !== Object.prototype) throw host('INVALID_ACROFORM_SIGNATURE_FIELD_OPTIONS', 'The signature-field rectangle is invalid.', 400);
  const rectDescriptors = Object.getOwnPropertyDescriptors(rect); const rectKeys = Reflect.ownKeys(rect);
  if (rectKeys.some((key) => typeof key !== 'string') || Object.keys(rectDescriptors).sort().join(',') !== 'height,width,x,y' || Object.values(rectDescriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('INVALID_ACROFORM_SIGNATURE_FIELD_OPTIONS', 'The signature-field rectangle contains unsupported fields or accessors.', 400);
  const frozen = { profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName: request.fieldName, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; Object.freeze(frozen.rect); return Object.freeze(frozen);
}
export class PdfAcroFormSignatureFieldService {
  #store; #core;
  constructor({ store, core = CORE } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function') || !core || typeof core.preparePdfAcroFormSignatureField !== 'function' || typeof core.inspectPdfAcroFormSignatureField !== 'function') throw new TypeError('PdfAcroFormSignatureFieldService requires a DocumentStore-compatible store and signature-field core.'); this.#store = store; this.#core = core; }
  async add(documentId, request, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const frozen = snapshot(request); if (frozen.profile !== PDF_ACROFORM_SIGNATURE_FIELD_PROFILE || !SHA256.test(String(frozen.sourceSha256 ?? ''))) throw host('INVALID_ACROFORM_SIGNATURE_FIELD_OPTIONS', 'A supported profile and lowercase source SHA-256 digest are required.', 400);
    const source = this.#store.getDocument(documentId); if (frozen.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The signature-field source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_ACROFORM_SIGNATURE_FIELD_SOURCE_BYTES) throw host('ACROFORM_SIGNATURE_FIELD_INPUT_TOO_LARGE', 'The signature-field source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_SIGNATURE_FIELD_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runAcroFormSignatureFieldJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle, core: this.#core }); }
    catch (error) {
      if (deadline.timedOut) throw host('ACROFORM_SIGNATURE_FIELD_TIMEOUT', 'AcroForm signature-field processing exceeded its deadline.', 504, error);
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED' || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'AcroForm signature-field processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_SIGNATURE_FIELD_SOURCE') throw host('ACROFORM_SIGNATURE_FIELD_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive AcroForm signature-field subset.', 422, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_SIGNATURE_FIELD_OUTPUT') throw host('ACROFORM_SIGNATURE_FIELD_OUTPUT_INVALID', 'Independent signature-field inspection rejected the output.', 502, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_SIGNATURE_FIELD') throw host('INVALID_ACROFORM_SIGNATURE_FIELD_OPTIONS', 'The signature-field request is invalid.', 400, error);
      throw host('ACROFORM_SIGNATURE_FIELD_FAILED', 'The local host could not create a verified empty AcroForm signature field.', 502, error);
    } finally { deadline.dispose(); await cleanupAcroFormSignatureFieldJob({ store: this.#store, lifecycle }); }
  }
}
export const AcroFormSignatureFieldService = PdfAcroFormSignatureFieldService;
