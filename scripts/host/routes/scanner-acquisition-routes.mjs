import { HostError } from '../host-error.mjs';
import {
  SCANNER_ACQUISITION_COLORS,
  SCANNER_ACQUISITION_DPIS,
  SCANNER_ACQUISITION_MAX_BYTES,
  SCANNER_ACQUISITION_MAX_DEADLINE_MS,
  SCANNER_ACQUISITION_PROFILE,
} from '../scanner-acquisition-contract.mjs';
import { validateOperationProvenance } from '../operation-provenance.mjs';
import { scheduleDocumentCleanup } from './artifact-response-lifecycle.mjs';

const DEVICE_ID = /^scanner-[0-9a-f]{32}$/u;
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const DOCUMENT_KEYS = ['id', 'displayName', 'mediaType', 'size', 'sha256', 'origin', 'operation', 'createdAt'];
const EVIDENCE_KEYS = ['sourceFree', 'pageCount', 'helperVerified', 'outputDigestBound', 'localOnly'];
const VALIDATORS = ['pinned-helper-sha256', 'private-workspace', 'scanner-output-identity', 'scanner-output-digest', 'pdf-header', 'single-page-acquisition'];

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => descriptors[key]?.enumerable === true
        && Object.hasOwn(descriptors[key], 'value'));
  } catch { return false; }
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function validTimestamp(value) {
  try { return typeof value === 'string' && new Date(value).toISOString() === value; } catch { return false; }
}

function validOperation(value, request, document) {
  try { validateOperationProvenance(value); } catch { return false; }
  const parameters = value.parameters;
  const expected = value.expected;
  const validation = value.validation;
  return value.type === 'scan-acquire' && Array.isArray(value.inputs) && value.inputs.length === 0
    && exact(parameters, ['profile', 'deviceId', 'source', 'duplex', 'color', 'dpi', 'pageCount', 'format'])
    && parameters.profile === SCANNER_ACQUISITION_PROFILE && parameters.deviceId === request.deviceId
    && parameters.source === 'flatbed' && parameters.duplex === false && parameters.color === request.color
    && parameters.dpi === request.dpi && parameters.pageCount === 1 && parameters.format === 'PDF'
    && exact(expected, ['pageCount', 'outputSha256', 'sourceFree']) && expected.pageCount === 1
    && expected.outputSha256 === document.sha256 && expected.sourceFree === true
    && exact(validation, ['passed', 'validators', 'outputSha256']) && validation.passed === true
    && Array.isArray(validation.validators) && sameJson(validation.validators, VALIDATORS)
    && validation.outputSha256 === document.sha256;
}

function publicDocument(value, request) {
  if (!exact(value, DOCUMENT_KEYS) || !DOCUMENT_ID.test(value.id ?? '') || value.displayName !== 'scan.pdf'
    || value.mediaType !== 'application/pdf' || !Number.isSafeInteger(value.size)
    || value.size < 1 || value.size > SCANNER_ACQUISITION_MAX_BYTES || !SHA256.test(value.sha256 ?? '')
    || value.origin !== 'derived' || !validTimestamp(value.createdAt)) return false;
  return validOperation(value.operation, request, value);
}

function validEvidence(value) {
  return exact(value, EVIDENCE_KEYS) && value.sourceFree === true && value.pageCount === 1
    && value.helperVerified === true && value.outputDigestBound === true && value.localOnly === true;
}

function parseRequest(body, exactJsonObject) {
  if (!exactJsonObject(body, ['deviceId', 'color', 'dpi']) || !DEVICE_ID.test(body.deviceId ?? '')
    || !SCANNER_ACQUISITION_COLORS.includes(body.color) || !SCANNER_ACQUISITION_DPIS.includes(body.dpi)) {
    throw new HostError('INVALID_SCANNER_ACQUISITION_REQUEST', 'Scanner acquisition requires an exact bounded request.', 400);
  }
  return Object.freeze({
    profile: SCANNER_ACQUISITION_PROFILE,
    deviceId: body.deviceId,
    source: 'flatbed',
    duplex: false,
    color: body.color,
    dpi: body.dpi,
    pageCount: 1,
    maxBytes: SCANNER_ACQUISITION_MAX_BYTES,
    deadlineMs: SCANNER_ACQUISITION_MAX_DEADLINE_MS,
    format: 'PDF',
  });
}

function validateResult(value, request, store) {
  if (!exact(value, ['kind', 'document', 'operation', 'evidence']) || value.kind !== 'scan-acquire'
    || !publicDocument(value.document, request) || !sameJson(value.document.operation, value.operation)
    || !validEvidence(value.evidence)) {
    throw new HostError('INVALID_SCANNER_ACQUISITION_RESULT', 'Scanner acquisition returned invalid local evidence.', 502);
  }
  let retained;
  try { retained = store.getDocument(value.document.id); } catch { retained = null; }
  if (!publicDocument(retained, request) || !sameJson(retained, value.document)) {
    throw new HostError('INVALID_SCANNER_ACQUISITION_RESULT', 'The retained scanner document could not be revalidated.', 502);
  }
  return Object.freeze({ document: retained, operation: retained.operation, evidence: value.evidence });
}

function safeFailureEvidence(value) {
  return exact(value, ['api', 'discoveryAttempted', 'liveVerification', 'scanSupport'])
    && value.api === 'ImageCaptureCore' && typeof value.discoveryAttempted === 'boolean'
    && value.liveVerification === false
    && ['unsupported', 'unavailable-on-platform'].includes(value.scanSupport);
}

export async function handleScannerAcquisitionRoute(context) {
  const { pathname, request, response, url, processing, scannerAcquisition, scannerAcquisitionReady,
    store, method, readJson, json, exactJsonObject } = context;
  if (pathname !== '/api/scanners/acquire') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Scanner acquisition does not accept query parameters.', 400);
  }
  if (!scannerAcquisitionReady || !scannerAcquisition) {
    throw new HostError('SCANNER_ACQUISITION_UNAVAILABLE', 'The scanner acquisition helper is unavailable.', 503);
  }
  if (!store || typeof store.getDocument !== 'function' || typeof store.deleteDocument !== 'function') {
    throw new HostError('SCANNER_ACQUISITION_UNAVAILABLE', 'The retained document store is unavailable.', 503);
  }
  const options = parseRequest(await readJson(request, 256), exactJsonObject);
  try {
    const result = validateResult(await scannerAcquisition.acquire(options, { signal: processing.signal }), options, store);
    if (await scheduleDocumentCleanup({ processing, response, store }, result.document.id)) return true;
    json(response, 201, result);
  } catch (error) {
    if (processing.signal.aborted || error?.code === 'ENGINE_CANCELLED') {
      throw new HostError('JOB_CANCELLED', 'Scanner acquisition was cancelled.', 499, { cause: error });
    }
    if (error instanceof HostError && safeFailureEvidence(error.evidence)) {
      json(response, error.status, { error: { code: error.code, message: error.message, evidence: error.evidence } });
      return true;
    }
    if (error instanceof HostError) throw error;
    throw new HostError('SCANNER_ACQUISITION_FAILED', 'The scanner helper could not complete a validated acquisition.', 502, { cause: error });
  }
  return true;
}
