import {
  normalizeAecCalibrationRequest,
  normalizeAecMaterializationRequest,
  normalizeAecMeasurementRequest,
  validateAecCalibrationResult,
  validateAecMaterializationResult,
  validateAecMeasurementResult,
} from './aec-contract.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

/** Source-bound AEC calibration, measurement, and native materialization transport. */
export function createAecEndpoints({ json }) {
  return {
    calibrateAec(documentId, request, { signal } = {}) {
      return postJson(
        json,
        documentEndpointPath(documentId, '/aec-calibration'),
        normalizeAecCalibrationRequest(request),
        signal,
      ).then((body) => validateAecCalibrationResult(body.result));
    },
    measureAec(documentId, request, { signal } = {}) {
      return postJson(
        json,
        documentEndpointPath(documentId, '/aec-measurement'),
        normalizeAecMeasurementRequest(request),
        signal,
      ).then((body) => validateAecMeasurementResult(body.result));
    },
    materializeAec(documentId, request, { signal } = {}) {
      return postJson(
        json,
        documentEndpointPath(documentId, '/aec-materialization'),
        normalizeAecMaterializationRequest(request),
        signal,
      ).then((body) => validateAecMaterializationResult(body.result));
    },
  };
}
