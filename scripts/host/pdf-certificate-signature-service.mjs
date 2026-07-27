import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupCertificateSignatureJob, CERTIFICATE_SIGNATURE_PROFILE, MAX_CERTIFICATE_SIGNATURE_JOB_MS, MAX_CERTIFICATE_SIGNATURE_SOURCE_BYTES, runCertificateSignatureJob } from './pdf-certificate-signature-job.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const STORE_METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);

function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }

export class PdfCertificateSignatureService {
  #store; #adapter;

  constructor({ store, adapter = null } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfCertificateSignatureService requires a DocumentStore-compatible store.');
    this.#store = store; this.#adapter = adapter;
  }

  async sign(documentId, request, { certificateSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (!SHA256.test(String(certificateSha256 ?? ''))) throw host('INVALID_CERTIFICATE_SHA256', 'certificateSha256 must be a lowercase SHA-256 digest.', 400);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw host('INVALID_CERTIFICATE_SIGNATURE_REQUEST', 'A source-bound PDF signature-container request is required.', 400);
    const source = this.#store.getDocument(documentId);
    const sourceDigestDescriptor = Object.getOwnPropertyDescriptor(request, 'sourceSha256');
    const requestSourceSha256 = sourceDigestDescriptor && Object.hasOwn(sourceDigestDescriptor, 'value') ? sourceDigestDescriptor.value : null;
    if (!SHA256.test(String(requestSourceSha256 ?? '')) || requestSourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The signature-container source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_CERTIFICATE_SIGNATURE_SOURCE_BYTES) throw host('CERTIFICATE_SIGNATURE_INPUT_TOO_LARGE', 'Certificate signatures are limited to bounded PDF sources.', 413);
    const deadline = createDeadline(signal, MAX_CERTIFICATE_SIGNATURE_JOB_MS);
    const lifecycle = { workspace: null, verificationWorkspace: null, promotedArtifact: null, completed: false };
    try {
      return await runCertificateSignatureJob({ store: this.#store, adapter: this.#adapter, documentId, source, request, certificateSha256, deadline, lifecycle });
    } catch (error) {
      if (deadline.timedOut) throw host('CERTIFICATE_SIGNATURE_TIMEOUT', 'Certificate signature processing exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED') throw host('JOB_CANCELLED', 'Certificate signature processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_SIGNATURE_CONTAINER_SOURCE') throw host('CERTIFICATE_SIGNATURE_SOURCE_UNSUPPORTED', 'The PDF is outside the supported passive certificate-signature container subset.', 422, error);
      if (error?.code === 'INVALID_PDF_SIGNATURE_CONTAINER') throw host('INVALID_CERTIFICATE_SIGNATURE_REQUEST', 'The PDF signature-container request is invalid.', 400, error);
      if (error?.code === 'INVALID_PDF_SIGNATURE_CONTAINER_OUTPUT') throw host('CERTIFICATE_SIGNATURE_OUTPUT_INVALID', 'The independently inspected signature-container output is invalid.', 502, error);
      throw host('CERTIFICATE_SIGNATURE_FAILED', 'The local host could not create a verified certificate-signature container.', 502, error);
    } finally {
      deadline.dispose();
      await cleanupCertificateSignatureJob({ store: this.#store, lifecycle });
    }
  }
}

export const CertificateSignatureService = PdfCertificateSignatureService;
export { CERTIFICATE_SIGNATURE_PROFILE };
