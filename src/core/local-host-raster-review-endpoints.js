import { exactObject, validPdfKitRectangle } from './pdfkit-client-contract.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import {
  createRedactionApplicationRequest,
  createRedactionPlanRequest,
  createRedactionPlanReportRequest,
  validateAppliedRedactionPlanResponse,
  validateCreatedRedactionPlanResponse,
  validateRedactionPlanReport,
} from './redaction-plan-contract.js';

function validRasterRedactionEntry(entry) {
  return (exactObject(entry, ['page', 'removedText', 'fullPage']) && entry.fullPage === true)
    || (exactObject(entry, ['page', 'removedText', 'region'])
      && validPdfKitRectangle(entry.region));
}

function validRasterRedactionParameters(parameters) {
  return Boolean(parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    && Array.isArray(parameters.redactions)
    && parameters.redactions.length >= 1
    && parameters.redactions.length <= 64
    && parameters.redactions.every(validRasterRedactionEntry));
}

/** Raster mutation plus source-bound redaction proposal/application transport. */
export function createRasterReviewEndpoints({ json }) {
  return {
    mutateRaster(documentId, operation, parameters = {}, { signal } = {}) {
      if (operation === 'redact' && !validRasterRedactionParameters(parameters)) {
        throw new TypeError('Raster redaction parameters are invalid.');
      }
      return postJson(
        json,
        documentEndpointPath(documentId, '/mutation'),
        { operation, parameters },
        signal,
      ).then((body) => body.artifact);
    },
    createRedactionPlan(documentId, request, { signal } = {}) {
      const normalized = createRedactionPlanRequest(request);
      return postJson(
        json,
        documentEndpointPath(documentId, '/redaction-plan'),
        normalized,
        signal,
      ).then((body) => validateCreatedRedactionPlanResponse(
        body,
        normalized.sourceSha256,
      ));
    },
    applyRedactionPlan(documentId, request, { signal } = {}) {
      return postJson(
        json,
        documentEndpointPath(documentId, '/redaction-application'),
        createRedactionApplicationRequest(request),
        signal,
      ).then(validateAppliedRedactionPlanResponse);
    },
    exportRedactionPlanReport(documentId, request, { signal } = {}) {
      const normalized = createRedactionPlanReportRequest(request);
      return postJson(
        json,
        documentEndpointPath(documentId, '/redaction-report'),
        normalized,
        signal,
      ).then((body) => validateRedactionPlanReport(body, normalized));
    },
  };
}
