import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupAcroFormChoiceJob, MAX_PDF_ACROFORM_CHOICE_JOB_MS, MAX_PDF_ACROFORM_CHOICE_SOURCE_BYTES, runAcroFormChoiceJob } from './pdf-acroform-choice-job.mjs';
import { PDF_ACROFORM_CHOICE_PROFILE } from './pdf-acroform-choice-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const METHODS = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'];
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshot(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype) host('INVALID_ACROFORM_CHOICE_OPTIONS', 'A plain choice request is required.', 400);
  const descriptors = Object.getOwnPropertyDescriptors(request);
  if (Reflect.ownKeys(request).some((key) => typeof key !== 'string') || Object.keys(descriptors).sort().join(',') !== 'fieldName,options,page,profile,rect,sourceSha256' || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) host('INVALID_ACROFORM_CHOICE_OPTIONS', 'The choice request contains unsupported fields.', 400);
  if (!request.rect || typeof request.rect !== 'object' || Object.getPrototypeOf(request.rect) !== Object.prototype) host('INVALID_ACROFORM_CHOICE_OPTIONS', 'Choice geometry must be a plain object.', 400);
  const rectFields = Object.getOwnPropertyDescriptors(request.rect); if (Object.keys(rectFields).length !== 4 || ['x', 'y', 'width', 'height'].some((key) => !Object.hasOwn(rectFields, key) || !Object.hasOwn(rectFields[key], 'value') || rectFields[key].enumerable !== true)) host('INVALID_ACROFORM_CHOICE_OPTIONS', 'Choice geometry must contain data properties.', 400);
  if (!Array.isArray(request.options) || Object.getPrototypeOf(request.options) !== Array.prototype || Reflect.ownKeys(request.options).length !== request.options.length + 1) host('INVALID_ACROFORM_CHOICE_OPTIONS', 'Choice options are required.', 400);
  const options = request.options.map((entry) => { if (!entry || typeof entry !== 'object' || Object.getPrototypeOf(entry) !== Object.prototype) host('INVALID_ACROFORM_CHOICE_OPTIONS', 'Choice options must be plain objects.', 400); const fields = Object.getOwnPropertyDescriptors(entry); if (Object.keys(fields).length !== 1 || !Object.hasOwn(fields, 'label') || !Object.hasOwn(fields.label, 'value') || fields.label.enumerable !== true) host('INVALID_ACROFORM_CHOICE_OPTIONS', 'Choice option labels must be data properties.', 400); return Object.freeze({ label: entry.label }); });
  return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, fieldName: request.fieldName, rect: Object.freeze({ x: request.rect?.x, y: request.rect?.y, width: request.rect?.width, height: request.rect?.height }), options: Object.freeze(options) });
}
export class PdfAcroFormChoiceService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAcroFormChoiceService requires a DocumentStore-compatible store.'); this.#store = store; }
  async add(documentId, request, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const frozen = snapshot(request); if (frozen.profile !== PDF_ACROFORM_CHOICE_PROFILE || !SHA256.test(String(frozen.sourceSha256 ?? ''))) host('INVALID_ACROFORM_CHOICE_OPTIONS', 'A supported profile and lowercase source digest are required.', 400);
    const source = this.#store.getDocument(documentId); if (frozen.sourceSha256 !== source.sha256) host('SOURCE_VERSION_MISMATCH', 'The choice source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_ACROFORM_CHOICE_SOURCE_BYTES) host('ACROFORM_CHOICE_INPUT_TOO_LARGE', 'The choice source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_CHOICE_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runAcroFormChoiceJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle }); }
    catch (error) { if (deadline.timedOut) host('ACROFORM_CHOICE_TIMEOUT', 'AcroForm choice processing exceeded its deadline.', 504, error); if (signal?.aborted || error?.code === 'JOB_CANCELLED') host('JOB_CANCELLED', 'AcroForm choice processing was cancelled.', 499, error); if (error instanceof HostError) throw error; if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_CHOICE_SOURCE') host('ACROFORM_CHOICE_SOURCE_UNSUPPORTED', 'The source is outside the bounded choice subset.', 422, error); if (error?.code === 'INVALID_PDF_ACROFORM_CHOICE') host('INVALID_ACROFORM_CHOICE_OPTIONS', 'The choice request is invalid.', 400, error); if (error?.code === 'INVALID_PDF_ACROFORM_CHOICE_OUTPUT') host('ACROFORM_CHOICE_OUTPUT_INVALID', 'Independent choice inspection rejected the output.', 502, error); host('ACROFORM_CHOICE_FAILED', 'The local host could not create a verified choice form.', 502, error); }
    finally { deadline.dispose(); await cleanupAcroFormChoiceJob({ store: this.#store, lifecycle }); }
  }
}
export const AcroFormChoiceService = PdfAcroFormChoiceService;
