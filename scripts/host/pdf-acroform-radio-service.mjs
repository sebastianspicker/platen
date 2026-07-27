import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupAcroFormRadioJob, MAX_PDF_ACROFORM_RADIO_JOB_MS, MAX_PDF_ACROFORM_RADIO_SOURCE_BYTES, runAcroFormRadioJob } from './pdf-acroform-radio-job.mjs';
import { PDF_ACROFORM_RADIO_PROFILE } from './pdf-acroform-radio-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u; const METHODS = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'];
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshot(request) { if (!request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype) throw host('INVALID_ACROFORM_RADIO_OPTIONS', 'A plain radio request is required.', 400);
const d = Object.getOwnPropertyDescriptors(request);
if (Reflect.ownKeys(request).some((k) => typeof k !== 'string') || Object.keys(d).sort().join(',') !== 'groupName,options,profile,sourceSha256' || Object.values(d).some((x) => !Object.hasOwn(x, 'value') || x.enumerable !== true)) throw host('INVALID_ACROFORM_RADIO_OPTIONS', 'The radio request contains unsupported fields.', 400);
const options = request.options;
if (!Array.isArray(options)) throw host('INVALID_ACROFORM_RADIO_OPTIONS', 'Radio options are required.', 400);
const copy = { profile: request.profile, sourceSha256: request.sourceSha256, groupName: request.groupName, options: options.map((o) => ({ label: o.label, page: o.page, rect: { x: o.rect?.x, y: o.rect?.y, width: o.rect?.width, height: o.rect?.height } })) };
return Object.freeze({ ...copy, options: Object.freeze(copy.options.map((o) => Object.freeze({ ...o, rect: Object.freeze(o.rect) }))) });
}
export class PdfAcroFormRadioService { #store; constructor({ store } = {}) { if (!store || METHODS.some((m) => typeof store[m] !== 'function')) throw new TypeError('PdfAcroFormRadioService requires a DocumentStore-compatible store.'); this.#store = store; }
  async add(documentId, request, { signal } = {}) { if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  const frozen = snapshot(request);
  if (frozen.profile !== PDF_ACROFORM_RADIO_PROFILE || !SHA256.test(String(frozen.sourceSha256 ?? ''))) throw host('INVALID_ACROFORM_RADIO_OPTIONS', 'A supported profile and lowercase source digest are required.', 400);
  const source = this.#store.getDocument(documentId);
  if (frozen.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The radio source digest does not match the current document.', 409);
  if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_ACROFORM_RADIO_SOURCE_BYTES) throw host('ACROFORM_RADIO_INPUT_TOO_LARGE', 'The radio source exceeds its fixed bound.', 413);
  const deadline = createDeadline(signal, MAX_PDF_ACROFORM_RADIO_JOB_MS);
  const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
  try { return await runAcroFormRadioJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle });
  } catch (error) { if (deadline.timedOut) throw host('ACROFORM_RADIO_TIMEOUT', 'AcroForm radio processing exceeded its deadline.', 504, error);
  if (signal?.aborted || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'AcroForm radio processing was cancelled.', 499, error);
  if (error instanceof HostError) throw error;
  if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_RADIO_SOURCE') throw host('ACROFORM_RADIO_SOURCE_UNSUPPORTED', 'The source is outside the bounded radio subset.', 422, error);
  if (error?.code === 'INVALID_PDF_ACROFORM_RADIO') throw host('INVALID_ACROFORM_RADIO_OPTIONS', 'The radio request is invalid.', 400, error);
  if (error?.code === 'INVALID_PDF_ACROFORM_RADIO_OUTPUT') throw host('ACROFORM_RADIO_OUTPUT_INVALID', 'Independent radio inspection rejected the output.', 502, error);
  throw host('ACROFORM_RADIO_FAILED', 'The local host could not create a verified radio form.', 502, error);
  } finally { deadline.dispose();
  await cleanupAcroFormRadioJob({ store: this.#store, lifecycle });
  } }
}
export const AcroFormRadioService = PdfAcroFormRadioService;
