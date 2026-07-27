import { HostError } from './host-error.mjs';

const MAX_JOB_MS = 2 * 60_000;

export function createPdfKitMutationJob(externalSignal) {
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  if (externalSignal?.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('PDFKit mutation deadline exceeded.'));
  }, MAX_JOB_MS);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  });
}

export function translatePdfKitMutationError(error, { job, externalSignal }) {
  if (job.timedOut) {
    return new HostError(
      'PDFKIT_MUTATION_TIMEOUT',
      'PDFKit mutation exceeded its two-minute deadline.',
      504,
      { cause: error },
    );
  }
  if (externalSignal?.aborted) {
    return new HostError(
      'JOB_CANCELLED',
      'PDFKit mutation was cancelled.',
      499,
      { cause: error },
    );
  }
  if (error instanceof HostError) return error;
  const status = error?.code === 'MUTATION_FAILED' || error?.code === 'INVALID_REQUEST'
    ? 422
    : 502;
  return new HostError(
    'PDFKIT_MUTATION_FAILED',
    'The pinned local PDFKit helper could not apply and validate this mutation.',
    status,
    { cause: error },
  );
}
