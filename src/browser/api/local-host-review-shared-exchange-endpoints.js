import {
  validateReviewSharedExchangeExportResult,
  validateReviewSharedExchangeImportResult,
  validReviewSharedExchangeArchive,
} from '../../contracts/local-host-review-shared-exchange-contract.js';
import { OPAQUE_ID_PATTERN } from '../../contracts/pdfkit-client-contract-shared.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER = /^reviewer-[a-z0-9][a-z0-9._-]{0,63}$/u;

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

export function createReviewSharedExchangeEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Review shared-exchange endpoints require a JSON transport.');
  function optionsSignal(options) {
    const optionKeys = options?.signal === undefined ? [] : ['signal'];
    if (!exact(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      throw new TypeError('Review shared-exchange options are invalid.');
    }
    return options.signal;
  }
  function exportReviewSharedExchange(documentId, request, options = {}) {
    const signal = optionsSignal(options);
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exact(request, ['sourceSha256', 'baseRevision', 'reviewerId'])
      || !SHA256.test(request.sourceSha256 ?? '') || !Number.isSafeInteger(request.baseRevision)
      || request.baseRevision < 0 || !REVIEWER.test(request.reviewerId ?? '')) {
      throw new TypeError('Review shared-exchange export options are invalid.');
    }
    const body = {
      action: 'export', sourceSha256: request.sourceSha256,
      baseRevision: request.baseRevision, reviewerId: request.reviewerId,
    };
    return postJson(json, documentEndpointPath(documentId, '/review-shared-exchange'), body, signal)
      .then((response) => validateReviewSharedExchangeExportResult(response?.result, request));
  }
  function importReviewSharedExchange(documentId, request, options = {}) {
    const signal = optionsSignal(options);
    if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exact(request, ['sourceSha256', 'archiveBase64'])
      || !SHA256.test(request.sourceSha256 ?? '') || !validReviewSharedExchangeArchive(request.archiveBase64)) {
      throw new TypeError('Review shared-exchange import options are invalid.');
    }
    return postJson(json, documentEndpointPath(documentId, '/review-shared-exchange'), {
      action: 'import', sourceSha256: request.sourceSha256, archiveBase64: request.archiveBase64,
    }, signal).then((response) => validateReviewSharedExchangeImportResult(response?.result, request));
  }
  return Object.freeze({ exportReviewSharedExchange, importReviewSharedExchange });
}
