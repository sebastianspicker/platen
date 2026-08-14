import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupAcroFormCheckboxJob, MAX_PDF_ACROFORM_CHECKBOX_JOB_MS, MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES, runAcroFormCheckboxJob } from './pdf-acroform-checkbox-job.mjs';
import { PDF_ACROFORM_CHECKBOX_PROFILE } from './pdf-acroform-checkbox-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const STORE_METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }

function snapshotRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype) throw host('INVALID_ACROFORM_CHECKBOX_OPTIONS', 'A plain AcroForm checkbox request is required.', 400);
  const descriptors = Object.getOwnPropertyDescriptors(request); const keys = Reflect.ownKeys(request); if (keys.some((key) => typeof key !== 'string') || Object.keys(descriptors).length !== 5 || Object.keys(descriptors).sort().join(',') !== 'fieldName,page,profile,rect,sourceSha256' || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('INVALID_ACROFORM_CHECKBOX_OPTIONS', 'The AcroForm checkbox request contains unsupported fields.', 400);
  const rect = request.rect;
  if (!rect || typeof rect !== 'object' || Array.isArray(rect) || Object.getPrototypeOf(rect) !== Object.prototype) throw host('INVALID_ACROFORM_CHECKBOX_OPTIONS', 'The AcroForm checkbox rectangle is invalid.', 400);
  const rectDescriptors = Object.getOwnPropertyDescriptors(rect); const rectKeys = Reflect.ownKeys(rect); if (rectKeys.some((key) => typeof key !== 'string') || Object.keys(rectDescriptors).sort().join(',') !== 'height,width,x,y' || Object.values(rectDescriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('INVALID_ACROFORM_CHECKBOX_OPTIONS', 'The AcroForm checkbox rectangle is invalid.', 400);
  const frozen = { profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName: request.fieldName, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  Object.freeze(frozen.rect); return Object.freeze(frozen);
}

export class PdfAcroFormCheckboxService {
  #store;
  constructor({ store } = {}) { if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfAcroFormCheckboxService requires a DocumentStore-compatible store.'); this.#store = store; }

  async add(documentId, request, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const frozenRequest = snapshotRequest(request);
    if (frozenRequest.profile !== PDF_ACROFORM_CHECKBOX_PROFILE || !SHA256.test(String(frozenRequest.sourceSha256 ?? ''))) throw host('INVALID_ACROFORM_CHECKBOX_OPTIONS', 'A lowercase source SHA-256 digest and supported checkbox profile are required.', 400);
    const source = this.#store.getDocument(documentId);
    if (frozenRequest.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The AcroForm checkbox source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES) throw host('ACROFORM_CHECKBOX_INPUT_TOO_LARGE', 'The AcroForm checkbox source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_CHECKBOX_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runAcroFormCheckboxJob({ store: this.#store, documentId, source, request: frozenRequest, deadline, lifecycle }); }
    catch (error) {
      if (deadline.timedOut) throw host('ACROFORM_CHECKBOX_TIMEOUT', 'AcroForm checkbox processing exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED' || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'AcroForm checkbox processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_CHECKBOX_SOURCE') throw host('ACROFORM_CHECKBOX_SOURCE_UNSUPPORTED', 'The PDF is outside the bounded passive AcroForm checkbox subset.', 422, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_CHECKBOX_OUTPUT') throw host('ACROFORM_CHECKBOX_OUTPUT_INVALID', 'Independent AcroForm checkbox inspection rejected the output.', 502, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_CHECKBOX') throw host('INVALID_ACROFORM_CHECKBOX_OPTIONS', 'The AcroForm checkbox request is invalid.', 400, error);
      throw host('ACROFORM_CHECKBOX_FAILED', 'The local host could not create a verified AcroForm checkbox.', 502, error);
    } finally { deadline.dispose(); await cleanupAcroFormCheckboxJob({ store: this.#store, lifecycle }); }
  }
}

export const AcroFormCheckboxService = PdfAcroFormCheckboxService;
