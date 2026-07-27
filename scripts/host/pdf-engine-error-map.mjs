import { HostError } from './host-error.mjs';

export function mapEngineError(error) {
  if (error instanceof HostError) return error;
  if (error?.code === 'ENGINE_NOT_FOUND' || error?.code === 'ENGINE_UNKNOWN') {
    return new HostError(
      'ENGINE_UNAVAILABLE', 'The required local Poppler engine is unavailable.', 503,
      { cause: error },
    );
  }
  if (error?.code === 'ENGINE_TIMEOUT') {
    return new HostError(
      'ENGINE_TIMEOUT', 'Local PDF processing exceeded its time limit.', 504,
      { cause: error },
    );
  }
  if (error?.code === 'ENGINE_OUTPUT_LIMIT') {
    return new HostError(
      'ENGINE_OUTPUT_LIMIT',
      'Local PDF processing produced more data than the app can safely accept.',
      413,
      { cause: error },
    );
  }
  if (error?.code === 'ENGINE_QUEUE_FULL') {
    return new HostError(
      'ENGINE_BUSY',
      'The bounded local processing queue is full. Try again after the active jobs finish.',
      503,
      { cause: error },
    );
  }
  if (error?.code === 'ENGINE_HOST_UNHEALTHY') {
    return new HostError(
      'ENGINE_HOST_UNHEALTHY',
      'Native engine processes could not be reaped. Restart the local PDF host.',
      503,
      { cause: error },
    );
  }
  if (error?.code === 'ENGINE_CANCELLED') {
    return new HostError(
      'JOB_CANCELLED', 'Local PDF processing was cancelled.', 499, { cause: error },
    );
  }
  if (error?.code?.startsWith?.('ENGINE_')) {
    return new HostError(
      'PDF_PROCESSING_FAILED', 'Poppler could not process this PDF.', 422,
      { cause: error },
    );
  }
  return error;
}

export function mapSignatureInspectionError(error) {
  if (error instanceof HostError) return error;
  if (error?.code === 'ENGINE_TIMEOUT') {
    return new HostError(
      'SIGNATURE_INSPECTION_TIMEOUT',
      'Offline signature integrity inspection exceeded its time limit.',
      504,
      { cause: error },
    );
  }
  if (error?.code === 'ENGINE_CANCELLED') {
    return new HostError(
      'JOB_CANCELLED', 'Offline signature integrity inspection was cancelled.', 499,
      { cause: error },
    );
  }
  if (error?.code === 'ENGINE_OUTPUT_LIMIT') {
    return new HostError(
      'SIGNATURE_OUTPUT_LIMIT',
      'Offline signature integrity inspection produced more data than the app can safely accept.',
      413,
      { cause: error },
    );
  }
  if (error?.code?.startsWith?.('ENGINE_')) {
    return new HostError(
      'SIGNATURE_INSPECTION_UNAVAILABLE',
      'The isolated local signature integrity engine is unavailable.',
      503,
      { cause: error },
    );
  }
  return error;
}
