import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { PDF_JPEG_IMAGE_REPLACEMENT_PROFILE } from './pdf-jpeg-image-replacement-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u; const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ARTIFACT_KEYS = ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'];
function host(code, message, status = 400, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const ownKeys = Reflect.ownKeys(value); if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return false;
    const fields = Object.getOwnPropertyDescriptors(value); return Object.values(fields).every((descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
  } catch { return false; }
}
function snapshot(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw host('PDF_JPEG_IMAGE_REPLACEMENT_RESULT_INVALID', 'The replacement service returned cyclic data.', 502);
  seen.add(value);
  try {
    const fields = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string') || Object.values(fields).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('PDF_JPEG_IMAGE_REPLACEMENT_RESULT_INVALID', 'The replacement service returned accessor-backed data.', 502);
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => snapshot(entry, seen)));
    if (Object.getPrototypeOf(value) !== Object.prototype) throw host('PDF_JPEG_IMAGE_REPLACEMENT_RESULT_INVALID', 'The replacement service returned a non-plain result.', 502);
    return Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, descriptor]) => [key, snapshot(descriptor.value, seen)])));
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw host('PDF_JPEG_IMAGE_REPLACEMENT_RESULT_INVALID', 'The replacement service returned unsafe result data.', 502, error);
  } finally { seen.delete(value); }
}
function validate(value) { if (!exact(value, ['profile', 'sourceSha256', 'inputId', 'inputSha256', 'page', 'resourceName'])) throw host('INVALID_PDF_JPEG_IMAGE_REPLACEMENT_OPTIONS', 'JPEG replacement requires fixed profile, source/input digests, page, and resource name.'); const descriptors = Object.getOwnPropertyDescriptors(value); if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('INVALID_PDF_JPEG_IMAGE_REPLACEMENT_OPTIONS', 'JPEG replacement requires plain data fields.'); const snapshot = { profile: descriptors.profile.value, sourceSha256: descriptors.sourceSha256.value, inputId: descriptors.inputId.value, inputSha256: descriptors.inputSha256.value, page: descriptors.page.value, resourceName: descriptors.resourceName.value };
if (snapshot.profile !== PDF_JPEG_IMAGE_REPLACEMENT_PROFILE || !SHA256.test(snapshot.sourceSha256 ?? '') || !OPAQUE_ID.test(snapshot.inputId ?? '') || !SHA256.test(snapshot.inputSha256 ?? '') || !Number.isSafeInteger(snapshot.page) || snapshot.page < 1 || snapshot.page > 10_000 || typeof snapshot.resourceName !== 'string' || !/^[A-Za-z0-9_.-]{1,127}$/u.test(snapshot.resourceName)) throw host('INVALID_PDF_JPEG_IMAGE_REPLACEMENT_OPTIONS', 'JPEG replacement requires fixed profile, source/input digests, page, and resource name.'); return Object.freeze(snapshot); }
export class PdfJpegImageReplacementInputBroker {
  #inputs; #service; #store;
  constructor({ inputs, service, store } = {}) { if (!inputs || typeof inputs.getInput !== 'function' || typeof inputs.getSourcePath !== 'function' || typeof inputs.verifyInput !== 'function' || typeof service?.replace !== 'function' || !store || typeof store.getArtifact !== 'function' || typeof store.deleteArtifact !== 'function') throw new TypeError('PdfJpegImageReplacementInputBroker requires input, service, and artifact stores.'); this.#inputs = inputs; this.#service = service; this.#store = store; }
  async replace(documentId, value, { signal } = {}) {
    const request = validate(value); let result = null; let candidateResult = null; let trustedArtifactId = null; let bytes = null;
    try {
      if (signal?.aborted) throw host('JOB_CANCELLED', 'JPEG replacement was cancelled.', 499);
      const record = this.#inputs.getInput(request.inputId); await this.#inputs.verifyInput(request.inputId); if (record.mediaType !== 'image/jpeg' || !['.jpg', '.jpeg'].includes(record.extension) || !SHA256.test(record.sha256) || record.sha256 !== request.inputSha256 || record.size < 12 || record.size > 16 * 1024 * 1024) throw host('PDF_JPEG_IMAGE_REPLACEMENT_INPUT_INVALID', 'The private replacement JPEG record is invalid.', 409);
      bytes = await readFile(this.#inputs.getSourcePath(request.inputId)); if (bytes.length !== record.size || createHash('sha256').update(bytes).digest('hex') !== request.inputSha256) throw host('PDF_JPEG_IMAGE_REPLACEMENT_INPUT_TAMPERED', 'The private replacement JPEG changed while being read.', 409);
      candidateResult = await this.#service.replace(documentId, { profile: request.profile, sourceSha256: request.sourceSha256, page: request.page, resourceName: request.resourceName, jpegBytes: bytes }, { sourceSha256: request.sourceSha256, signal });
      candidateResult = snapshot(candidateResult); const candidateArtifact = candidateResult.artifact; if (!exact(candidateArtifact, ARTIFACT_KEYS) || candidateArtifact.mediaType !== 'application/pdf' || !OPAQUE_ID.test(candidateArtifact.id ?? '') || !SHA256.test(candidateArtifact.sha256 ?? '')) throw host('PDF_JPEG_IMAGE_REPLACEMENT_RESULT_INVALID', 'The replacement service returned an invalid artifact result.', 502);
      const candidateArtifactId = candidateArtifact.id; const candidateArtifactSha256 = candidateArtifact.sha256; const stored = this.#store.getArtifact(candidateArtifactId); if (!stored || stored.id !== candidateArtifactId || stored.sha256 !== candidateArtifactSha256) throw host('PDF_JPEG_IMAGE_REPLACEMENT_RESULT_INVALID', 'The replacement service artifact did not match the trusted store.', 502); trustedArtifactId = stored.id;
      result = candidateResult;
      if (signal?.aborted) throw host('JOB_CANCELLED', 'JPEG replacement was cancelled.', 499);
      return result;
    } catch (error) { if (trustedArtifactId) await this.#store.deleteArtifact(trustedArtifactId).catch((cause) => { throw host('PDF_JPEG_IMAGE_REPLACEMENT_CLEANUP_FAILED', 'Replacement artifact cleanup failed.', 500, cause); }); throw error; }
    finally { bytes?.fill(0); }
  }
}
export { validate as validateReplacementRequest };
