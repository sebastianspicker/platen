import { stat } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { parsePdfInfo } from './pdf-service-foundation.mjs';
import {
  createDeadline,
  createWorkspaceQuotaMonitor,
} from './workspace-job-runtime.mjs';

export const MAX_CONVERSION_JOB_MS = 3 * 60_000;
const MAX_CONVERSION_OUTPUT_BYTES = 512 * 1024 * 1024;

export function mapConversionError(error, { timedOut = false, cancelled = false } = {}) {
  if (error instanceof HostError) return error;
  if (timedOut || error?.code === 'ENGINE_TIMEOUT') {
    return new HostError(
      'CONVERSION_TIMEOUT', 'Local conversion exceeded its three-minute deadline.', 504,
      { cause: error },
    );
  }
  if (cancelled || error?.code === 'ENGINE_CANCELLED') {
    return new HostError(
      'JOB_CANCELLED', 'Local conversion was cancelled.', 499, { cause: error },
    );
  }
  if (error?.code === 'ENGINE_QUEUE_FULL') {
    return new HostError(
      'ENGINE_BUSY', 'The local processing queue is full.', 503, { cause: error },
    );
  }
  if (error?.code === 'ENGINE_HOST_UNHEALTHY') {
    return new HostError(
      'ENGINE_HOST_UNHEALTHY',
      'Native engine processes could not be reaped. Restart the local host.',
      503,
      { cause: error },
    );
  }
  if (error?.code === 'ENGINE_NOT_FOUND' || error?.code === 'ENGINE_UNKNOWN') {
    return new HostError(
      'ENGINE_UNAVAILABLE', 'The required local conversion engine is unavailable.', 503,
      { cause: error },
    );
  }
  if (error?.code?.startsWith?.('ENGINE_')) {
    return new HostError(
      'CONVERSION_FAILED', 'The local engine could not convert this input.', 422,
      { cause: error },
    );
  }
  return error;
}

export async function runConversionJob({
  owner,
  resourceId,
  externalSignal,
  action,
}) {
  const workspace = await owner.createJobWorkspace(resourceId);
  const deadline = createDeadline(externalSignal, MAX_CONVERSION_JOB_MS);
  const quota = createWorkspaceQuotaMonitor(workspace, deadline);
  let result;
  let failure = null;
  let promotedDocument = null;
  const registerPromotedDocument = (document) => {
    if (!document || typeof document.id !== 'string') {
      throw new HostError('CONVERSION_OUTPUT_INVALID', 'Conversion did not return a revocable derived document.', 502);
    }
    promotedDocument = document;
  };
  try {
    result = await action({
      workspace,
      signal: deadline.signal,
      checkQuota: quota.check,
      registerPromotedDocument,
    });
    if (deadline.signal.aborted) throw deadline.signal.reason ?? new Error('Conversion was cancelled.');
    if (typeof owner.verifySource === 'function') await owner.verifySource(resourceId);
  } catch (error) {
    failure = quota.error ?? mapConversionError(error, {
      timedOut: deadline.timedOut,
      cancelled: externalSignal?.aborted,
    });
  } finally {
    quota.stop();
    deadline.dispose();
    try {
      await owner.cleanupJob(workspace);
    } catch (error) {
      failure ??= new HostError(
        'CONVERSION_CLEANUP_FAILED', 'The private conversion workspace could not be removed.', 500,
        { cause: error },
      );
    }
    if (failure && promotedDocument) {
      try {
        await owner.deleteDocument(promotedDocument.id);
      } catch (error) {
        failure = new HostError(
          'CONVERSION_CLEANUP_FAILED',
          'The private conversion workspace or derived document could not be removed.',
          500,
          { cause: new AggregateError([failure, error], 'Conversion cleanup and document revocation failed.') },
        );
      }
    }
  }
  if (failure) throw failure;
  return result;
}

export async function inspectConversionOutput(poppler, filePath, signal) {
  const outputStat = await stat(filePath).catch(() => null);
  if (!outputStat?.isFile() || outputStat.size === 0
    || outputStat.size > MAX_CONVERSION_OUTPUT_BYTES) {
    throw new HostError(
      'INVALID_ENGINE_OUTPUT',
      'The conversion engine did not produce a bounded PDF file.',
      502,
    );
  }
  try {
    const result = await poppler.execute('inspect', { input: filePath }, {
      signal,
      timeoutMs: 30_000,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 256 * 1024,
    });
    return parsePdfInfo(result.stdout);
  } catch (error) {
    throw mapConversionError(error);
  }
}
