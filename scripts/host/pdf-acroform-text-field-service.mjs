import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupAcroFormTextFieldJob, MAX_PDF_ACROFORM_TEXT_FIELD_JOB_MS, MAX_PDF_ACROFORM_TEXT_FIELD_SOURCE_BYTES, runAcroFormTextFieldJob } from './pdf-acroform-text-field-job.mjs';
import { PDF_ACROFORM_TEXT_FIELD_PROFILE } from './pdf-acroform-text-field-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshot(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype) throw host('INVALID_ACROFORM_TEXT_FIELD_OPTIONS', 'A plain AcroForm text-field request is required.', 400);
  const descriptors = Object.getOwnPropertyDescriptors(request); const keys = Reflect.ownKeys(request);
  if (keys.some((key) => typeof key !== 'string') || Object.keys(descriptors).sort().join(',') !== 'fieldName,page,profile,rect,sourceSha256' || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('INVALID_ACROFORM_TEXT_FIELD_OPTIONS', 'The text-field request contains unsupported fields or accessors.', 400);
  const rect = request.rect; if (!rect || typeof rect !== 'object' || Array.isArray(rect) || Object.getPrototypeOf(rect) !== Object.prototype) throw host('INVALID_ACROFORM_TEXT_FIELD_OPTIONS', 'The text-field rectangle is invalid.', 400);
  const rectDescriptors = Object.getOwnPropertyDescriptors(rect); const rectKeys = Reflect.ownKeys(rect);
  if (rectKeys.some((key) => typeof key !== 'string') || Object.keys(rectDescriptors).sort().join(',') !== 'height,width,x,y' || Object.values(rectDescriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('INVALID_ACROFORM_TEXT_FIELD_OPTIONS', 'The text-field rectangle contains unsupported fields or accessors.', 400);
  const frozen = { profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName: request.fieldName, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; Object.freeze(frozen.rect); return Object.freeze(frozen);
}

export class PdfAcroFormTextFieldService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAcroFormTextFieldService requires a DocumentStore-compatible store.'); this.#store = store; }

  async add(documentId, request, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const frozen = snapshot(request); if (frozen.profile !== PDF_ACROFORM_TEXT_FIELD_PROFILE || !SHA256.test(String(frozen.sourceSha256 ?? ''))) throw host('INVALID_ACROFORM_TEXT_FIELD_OPTIONS', 'A supported profile and lowercase source SHA-256 digest are required.', 400);
    const source = this.#store.getDocument(documentId); if (frozen.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The text-field source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_ACROFORM_TEXT_FIELD_SOURCE_BYTES) throw host('ACROFORM_TEXT_FIELD_INPUT_TOO_LARGE', 'The text-field source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_TEXT_FIELD_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runAcroFormTextFieldJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle }); }
    catch (error) {
      if (deadline.timedOut) throw host('ACROFORM_TEXT_FIELD_TIMEOUT', 'AcroForm text-field processing exceeded its deadline.', 504, error);
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED' || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'AcroForm text-field processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_TEXT_FIELD_SOURCE') throw host('ACROFORM_TEXT_FIELD_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive AcroForm text-field subset.', 422, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_TEXT_FIELD_OUTPUT') throw host('ACROFORM_TEXT_FIELD_OUTPUT_INVALID', 'Independent text-field inspection rejected the output.', 502, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_TEXT_FIELD') throw host('INVALID_ACROFORM_TEXT_FIELD_OPTIONS', 'The AcroForm text-field request is invalid.', 400, error);
      throw host('ACROFORM_TEXT_FIELD_FAILED', 'The local host could not create a verified AcroForm text field.', 502, error);
    } finally { deadline.dispose(); await cleanupAcroFormTextFieldJob({ store: this.#store, lifecycle }); }
  }
}

export const AcroFormTextFieldService = PdfAcroFormTextFieldService;
