import { createHash } from 'node:crypto';
import { HostError } from '../host-error.mjs';
import {
  REVIEW_SHARED_EXCHANGE_MAX_BYTES,
  REVIEW_SHARED_EXCHANGE_MEDIA_TYPE,
  REVIEW_SHARED_EXCHANGE_PROFILE,
  parseReviewSharedExchangeManifest,
} from '../pdf-review-shared-exchange-contract.mjs';
import {
  validateReviewSharedExchangeExportResult,
  validateReviewSharedExchangeImportResult,
} from '../../../src/core/local-host-review-shared-exchange-endpoints.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_BASE64_LENGTH = Math.ceil(REVIEW_SHARED_EXCHANGE_MAX_BYTES / 3) * 4;

function decodeArchive(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_BASE64_LENGTH || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new HostError('INVALID_REVIEW_SHARED_EXCHANGE_OPTIONS', 'Review exchange archiveBase64 is not canonical base64.', 400);
  }
  let bytes;
  try { bytes = Buffer.from(value, 'base64'); } catch (error) { throw new HostError('INVALID_REVIEW_SHARED_EXCHANGE_OPTIONS', 'Review exchange archiveBase64 is invalid.', 400, { cause: error }); }
  if (bytes.length < 1 || bytes.length > REVIEW_SHARED_EXCHANGE_MAX_BYTES || bytes.toString('base64') !== value) {
    throw new HostError('INVALID_REVIEW_SHARED_EXCHANGE_OPTIONS', 'Review exchange archiveBase64 is outside its fixed bound.', 400);
  }
  return bytes;
}

function currentSource(store, documentId, sourceSha256) {
  if (!store || typeof store.getDocument !== 'function') throw new HostError('SOURCE_DOCUMENT_UNAVAILABLE', 'The review-exchange source document is unavailable.', 404);
  let document;
  try { document = store.getDocument(documentId); } catch (error) { throw new HostError('SOURCE_DOCUMENT_UNAVAILABLE', 'The review-exchange source document is unavailable.', 404, { cause: error }); }
  if (document?.sha256 !== sourceSha256) throw new HostError('SOURCE_VERSION_MISMATCH', 'Review exchange source digest does not match the current document.', 409);
  return document;
}

function serviceExportResult(result, request) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Buffer.isBuffer(result.bytes)
    || result.bytes.length < 1 || result.bytes.length > REVIEW_SHARED_EXCHANGE_MAX_BYTES
    || result.size !== result.bytes.length || result.displayName !== 'review-exchange.platen.zip'
    || result.mediaType !== REVIEW_SHARED_EXCHANGE_MEDIA_TYPE || !SHA256.test(result.sha256 ?? '')
    || createHash('sha256').update(result.bytes).digest('hex') !== result.sha256) {
    throw new HostError('REVIEW_SHARED_EXCHANGE_RESULT_INVALID', 'The review-exchange service returned invalid archive evidence.', 502);
  }
  try {
    const manifest = parseReviewSharedExchangeManifest(result.manifest);
    if (manifest.sourceSha256 !== request.sourceSha256 || manifest.reviewerId !== request.reviewerId || manifest.baseRevision !== request.baseRevision) throw new Error('manifest mismatch');
  } catch (error) {
    throw new HostError('REVIEW_SHARED_EXCHANGE_RESULT_INVALID', 'The review-exchange service returned invalid manifest evidence.', 502, { cause: error });
  }
  return result;
}

export async function handleReviewSharedExchangeRoute(context) {
  if (context.operation !== 'review-shared-exchange') return false;
  const { request, response, url, documentId, processing, store, reviewSharedExchange, bodyLimit, exactJsonObject, method, readJson, json } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Review shared exchange does not accept query parameters.', 400);
  if (!reviewSharedExchange) {
    throw new HostError('REVIEW_SHARED_EXCHANGE_UNAVAILABLE', 'The local review-exchange service is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['action', 'sourceSha256', 'baseRevision', 'reviewerId'])
    && !exactJsonObject(body, ['action', 'sourceSha256', 'archiveBase64'])) {
    throw new HostError('INVALID_REVIEW_SHARED_EXCHANGE_OPTIONS', 'Review exchange requires an exact export or import body.', 400);
  }
  if (!SHA256.test(body.sourceSha256 ?? '')) throw new HostError('INVALID_REVIEW_SHARED_EXCHANGE_OPTIONS', 'Review exchange sourceSha256 is invalid.', 400);
  currentSource(store, documentId, body.sourceSha256);
  if (body.action === 'export') {
    if (typeof reviewSharedExchange.export !== 'function') throw new HostError('REVIEW_SHARED_EXCHANGE_UNAVAILABLE', 'The local review-exchange export service is unavailable.', 503);
    if (!exactJsonObject(body, ['action', 'sourceSha256', 'baseRevision', 'reviewerId'])
      || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 || !REVIEWER.test(body.reviewerId ?? '')) {
      throw new HostError('INVALID_REVIEW_SHARED_EXCHANGE_OPTIONS', 'Review exchange export requires reviewerId and baseRevision.', 400);
    }
    let result;
    try { result = serviceExportResult(await reviewSharedExchange.export(documentId, { reviewerId: body.reviewerId, baseRevision: body.baseRevision }, { signal: processing.signal }), body); }
    catch (error) { if (error?.code === 'INVALID_LOCAL_HOST') throw new HostError('REVIEW_SHARED_EXCHANGE_RESULT_INVALID', 'The review-exchange service returned invalid archive evidence.', 502, { cause: error }); throw error; }
    if (processing.signal.aborted || response.destroyed) return true;
    const archiveBase64 = result.bytes.toString('base64');
    const output = { kind: REVIEW_SHARED_EXCHANGE_PROFILE, archiveBase64, displayName: result.displayName, mediaType: result.mediaType, size: result.size, sha256: result.sha256, manifest: result.manifest };
    try { validateReviewSharedExchangeExportResult(output, body); } catch (error) { throw new HostError('REVIEW_SHARED_EXCHANGE_RESULT_INVALID', 'The review-exchange service returned invalid archive evidence.', 502, { cause: error }); }
    json(response, 200, { result: structuredClone(output) });
    return true;
  }
  if (body.action !== 'import') throw new HostError('INVALID_REVIEW_SHARED_EXCHANGE_OPTIONS', 'Review exchange action is unsupported.', 400);
  if (typeof reviewSharedExchange.import !== 'function') throw new HostError('REVIEW_SHARED_EXCHANGE_UNAVAILABLE', 'The local review-exchange import service is unavailable.', 503);
  const archive = decodeArchive(body.archiveBase64);
  let result;
  try { result = await reviewSharedExchange.import(documentId, archive, { signal: processing.signal }); }
  catch (error) { throw error; }
  if (processing.signal.aborted || response.destroyed) return true;
  try { validateReviewSharedExchangeImportResult(result, { sourceSha256: body.sourceSha256 }); } catch (error) { throw new HostError('REVIEW_SHARED_EXCHANGE_RESULT_INVALID', 'The review-exchange service returned an invalid import result.', 502, { cause: error }); }
  json(response, 200, { result: structuredClone(result) });
  return true;
}
