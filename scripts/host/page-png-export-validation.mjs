import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';
import { MAX_PAGE_COUNT, PNG_SIGNATURE } from './pdf-service-limits.mjs';
import { decodePng } from './raster-png-codec.mjs';

export const MAX_PAGE_PNG_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_PAGE_PNG_DIMENSION = 20_000;
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(code, message, status = 502) {
  throw new HostError(code, message, status);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validatePageInspection(inspection, page) {
  const pageCount = inspection?.pageCount;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGE_COUNT) {
    fail('CLI_INVALID_PDF_INSPECTION', 'PDF inspection did not return a bounded page count.');
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
    fail('CLI_PAGE_OUT_OF_RANGE', `Selected page must be an integer from 1 through ${pageCount}.`, 400);
  }
  return Object.freeze({ pageCount, page });
}

export function validatePagePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < PNG_SIGNATURE.length
    || bytes.length > MAX_PAGE_PNG_EXPORT_BYTES
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail('CLI_INVALID_ENGINE_OUTPUT', 'Page export did not return a bounded PNG payload.');
  }
  // decodePng verifies the complete chunk structure and CRCs, then bounds the
  // decoded raster through the existing local PNG contract.
  const decoded = decodePng(bytes);
  if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height)
    || decoded.width < 1 || decoded.height < 1
    || decoded.width > MAX_PAGE_PNG_DIMENSION || decoded.height > MAX_PAGE_PNG_DIMENSION) {
    fail('CLI_INVALID_ENGINE_OUTPUT', 'Page export PNG dimensions are outside the local bound.');
  }
  return Object.freeze({
    size: bytes.length,
    sha256: sha256(bytes),
    width: decoded.width,
    height: decoded.height,
    mediaType: 'image/png',
  });
}

export async function verifyRetainedSource(store, document) {
  if (!store || typeof store.verifySource !== 'function' || typeof store.getDocument !== 'function') {
    fail('CLI_SOURCE_VERIFY_UNAVAILABLE', 'The retained PDF source verifier is unavailable.', 503);
  }
  if (!document || typeof document.id !== 'string' || !SHA256.test(document.sha256 ?? '')) {
    fail('CLI_SOURCE_INTEGRITY_FAILED', 'The uploaded PDF document record is invalid.', 500);
  }
  await store.verifySource(document.id);
  const retained = store.getDocument(document.id);
  if (retained.id !== document.id || retained.sha256 !== document.sha256
    || retained.mediaType !== 'application/pdf') {
    fail('CLI_SOURCE_INTEGRITY_FAILED', 'The retained PDF source record changed during export.', 500);
  }
  return retained;
}
