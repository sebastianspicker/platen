import { createHash } from 'node:crypto';
import { HostError } from '../../host/host-error.mjs';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE, automationPresetDescriptor,
} from '../../host/automation/automation-operation-contract.mjs';
import { AUTOMATION_SUBMIT_CLI_GRANT, AUTOMATION_SUBMIT_CLI_PRINCIPAL } from '../automation-submit-authority.mjs';

const submissionOperations = new WeakMap();

function serializeSubmission(application, operation) {
  const previous = submissionOperations.get(application) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  submissionOperations.set(application, current);
  void current.finally(() => {
    if (submissionOperations.get(application) === current) submissionOperations.delete(application);
  }).catch(() => {});
  return current;
}

function matchingInspectJob(job, sha256) {
  return job?.type === 'automation_inspect_v1' && job.payload?.sha256 === sha256
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '');
}

function matchingOcrJob(job, sha256, options) {
  return job?.type === 'automation_ocr_v1' && job.payload?.sha256 === sha256
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '')
    && job.payload?.language === options.language && job.payload?.cleanupPreset === options.cleanupPreset
    && job.payload?.segmentation === options.segmentation
    && JSON.stringify(job.payload?.userDictionary) === JSON.stringify(options.userDictionary);
}

function matchingOutputIntentJob(job, sha256) {
  return job?.type === 'automation_output_intent_v1' && job.payload?.sha256 === sha256
    && job.payload?.profile === 'local-ghostscript-default-cmyk-output-intent-v1'
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '');
}

function matchingFullPageRedactionJob(job, sha256, pages) {
  return job?.type === 'automation_full_page_redaction_v1' && job.payload?.sha256 === sha256
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '')
    && JSON.stringify(job.payload?.pages) === JSON.stringify(pages);
}

function matchingPresetJob(job, sha256, preset) {
  let descriptor;
  try { descriptor = automationPresetDescriptor(preset); } catch { return false; }
  return job?.type === descriptor.type && job.payload?.preset === preset
    && job.payload?.sha256 === sha256 && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '');
}

function matchingSequenceJob(job, sha256, sequence) {
  return job?.type === 'automation_sequence_v1' && job.payload?.sha256 === sha256
    && job.payload?.sequenceId === sequence && job.payload?.sequenceVersion === 1
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '');
}

async function existingSubmission(automation, admission, document, matcher) {
  if (!matcher(admission.existing, document.sha256)) {
    throw new HostError('IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to a different job request.', 409);
  }
  const opened = await automation.sources.openVerified(admission.existing.payload.sourceId, document.sha256);
  opened.stream.destroy();
  if (opened.size !== document.size) {
    throw new HostError('AUTOMATION_SOURCE_MISMATCH', 'Automation source size is inconsistent.', 409);
  }
  return Object.freeze({
    source: Object.freeze({ id: opened.id, sha256: opened.sha256, size: opened.size }),
    queued: Object.freeze({ job: admission.existing, idempotent: true }),
  });
}

function defaultOcrIdempotencyKey(document, options) {
  const digest = createHash('sha256').update(JSON.stringify([
    options.language, options.cleanupPreset, options.segmentation, options.userDictionary,
  ])).digest('hex');
  return `ocr-${document.sha256}-${digest}`;
}

function defaultFullPageRedactionIdempotencyKey(document, pages) {
  return `full-page-redaction-${document.sha256}-${createHash('sha256').update(JSON.stringify(pages)).digest('hex')}`;
}

export function createSubmissionContext(command) {
  const isSequence = command.command === 'automation-submit-sequence';
  const operationByCommand = {
    'automation-submit-ocr': 'ocr',
    'automation-submit-output-intent': 'output-intent',
    'automation-submit-full-page-redaction': 'full-page-redaction',
  };
  const operation = command.command === 'automation-submit'
    ? command.operation
    : operationByCommand[command.command] ?? 'inspect';
  const isOcr = operation === 'ocr';
  const isOutputIntent = operation === 'output-intent';
  const isFullPageRedaction = operation === 'full-page-redaction';
  const isPreset = command.command === 'automation-submit' && command.preset !== undefined;
  const options = isOcr ? Object.freeze({ language: command.language ?? 'eng', cleanupPreset: command.cleanupPreset ?? 'document', segmentation: command.segmentation ?? 'auto', userDictionary: command.userDictionary ?? [] }) : null;
  let matcher = matchingInspectJob;
  if (isSequence) matcher = (job, sha256) => matchingSequenceJob(job, sha256, command.sequence);
  else if (isPreset) matcher = (job, sha256) => matchingPresetJob(job, sha256, command.preset);
  else if (isOcr) matcher = (job, sha256) => matchingOcrJob(job, sha256, options);
  else if (isOutputIntent) matcher = matchingOutputIntentJob;
  else if (isFullPageRedaction) {
    matcher = (job, sha256) => matchingFullPageRedactionJob(job, sha256, command.pages);
  }
  return Object.freeze({
    isOcr, isOutputIntent, isFullPageRedaction, isPreset, isSequence,
    sequence: command.sequence ?? null, preset: command.preset ?? null, options, operation,
    pages: isFullPageRedaction ? command.pages : null, matcher,
  });
}

export function enqueueSubmissionRequest(automation, source, context) {
  if (context.isSequence) return automation.registry.enqueueSequenceRequest(source, context.sequence);
  if (context.isPreset) return automation.registry.enqueuePresetRequest(source, context.preset);
  if (context.isOcr) return automation.registry.enqueueOcrRequest(source, context.options);
  if (context.isOutputIntent) return automation.registry.enqueueOutputIntentRequest(source);
  if (context.isFullPageRedaction) return automation.registry.enqueueFullPageRedactionRequest(source, { pages: context.pages });
  return automation.registry.enqueueRequest(source);
}

export function automationApiSelection(context) {
  if (context.isSequence) return Object.freeze({ kind: 'sequence', id: context.sequence, pages: null });
  if (context.isPreset) return Object.freeze({ kind: 'preset', id: context.preset, pages: null });
  if (context.isOcr && (context.options.language !== 'eng' || context.options.cleanupPreset !== 'document'
    || context.options.segmentation !== 'auto' || context.options.userDictionary.length !== 0)) {
    throw new HostError('AUTOMATION_API_OPERATION_DENIED', 'The automation API accepts only the fixed OCR operation.', 403);
  }
  const id = context.isOcr ? AUTOMATION_OCR_TYPE
    : context.isOutputIntent ? AUTOMATION_OUTPUT_INTENT_TYPE
      : context.isFullPageRedaction ? AUTOMATION_FULL_PAGE_REDACTION_TYPE : AUTOMATION_INSPECT_TYPE;
  return Object.freeze({ kind: 'operation', id, pages: context.isFullPageRedaction ? context.pages : null });
}

export function isAutomationApiRepresentable(context) {
  return !context.isOcr || (context.options.language === 'eng'
    && context.options.cleanupPreset === 'document' && context.options.segmentation === 'auto'
    && context.options.userDictionary.length === 0);
}

function submissionIdempotencyKey(document, context, idempotencyKey) {
  if (idempotencyKey !== null && idempotencyKey !== undefined) return idempotencyKey;
  if (context.isPreset) return `preset-${document.sha256}-${context.preset}`;
  if (context.isOcr) return defaultOcrIdempotencyKey(document, context.options);
  if (context.isFullPageRedaction) return defaultFullPageRedactionIdempotencyKey(document, context.pages);
  if (context.isSequence) return `sequence-${document.sha256}-${context.sequence}-1`;
  return `${context.isOutputIntent ? 'output-intent' : 'inspect'}-${document.sha256}`;
}

function sourceTransaction(source) {
  return Object.freeze({
    kind: 'source', id: source.id, sha256: source.sha256, size: source.size,
    sourceId: source.id, sourceSha256: source.sha256,
  });
}

async function recoverAmbiguousEnqueue(automation, source, context, key, error) {
  const after = await automation.queue.admission(key).catch(() => null);
  const matches = after && context.matcher(after.existing, source.sha256)
    && after.existing.payload.sourceId === source.id;
  if (!matches) {
    if (after) await automation.sources.discardCreated(source);
    throw error;
  }
  await automation.sources.commit(source);
  return Object.freeze({ job: after.existing, idempotent: true });
}

async function stageNewSubmission(application, automation, document, context, key, runtime, signal) {
  let source;
  try {
    source = await automation.sources.stageDocument({
      store: application.store, documentId: document.id, signal,
    });
  } catch (error) {
    if (signal?.aborted) runtime.cancelled(signal);
    throw error;
  }
  const request = enqueueSubmissionRequest(automation, source, context);
  try {
    runtime.cancelled(signal);
    const queued = await automation.queue.enqueue({
      ...request, idempotencyKey: key, transaction: sourceTransaction(source),
    });
    await automation.sources.commit(source);
    return Object.freeze({ source, queued });
  } catch (error) {
    const queued = await recoverAmbiguousEnqueue(automation, source, context, key, error);
    return Object.freeze({ source, queued });
  }
}

async function admitSubmission(application, automation, document, context, idempotencyKey, runtime, signal) {
  runtime.cancelled(signal);
  const key = submissionIdempotencyKey(document, context, idempotencyKey);
  const admission = await automation.queue.admission(key);
  runtime.cancelled(signal);
  if (admission.existing) {
    return existingSubmission(automation, admission, document, context.matcher);
  }
  if (!admission.accepting) throw new HostError('QUEUE_FULL', 'The durable queue is full.', 429);
  return stageNewSubmission(application, automation, document, context, key, runtime, signal);
}

export function stageSubmission(application, automation, document, context, idempotencyKey, runtime, signal) {
  return serializeSubmission(application, () => (
    admitSubmission(application, automation, document, context, idempotencyKey, runtime, signal)
  ));
}

export async function submitSingleDocument(application, automation, command, runtime, signal, context = createSubmissionContext(command), idempotencyKey = command.idempotencyKey) {
  const document = await runtime.uploadPdf(application, command.input, signal);
  try { return await stageSubmission(application, automation, document, context, idempotencyKey, runtime, signal); }
  finally { await application.store.deleteDocument(document.id); }
}

function admissionMayBeDurable(error) {
  return error?.code === 'AUTOMATION_API_ADMISSION_UNCERTAIN'
    || error?.code === 'AUTOMATION_API_ADMISSION_CONFLICT'
    || error?.code === 'AUTOMATION_API_SOURCE_COMMIT_UNCERTAIN';
}

async function submitThroughApi(application, automation, document, context, idempotencyKey, runtime, signal) {
  const source = await automation.sources.stageDocument({ store: application.store, documentId: document.id, signal });
  const key = submissionIdempotencyKey(document, context, idempotencyKey);
  try {
    runtime.cancelled(signal);
    const receipt = await automation.api.submit(Object.freeze({
      principal: AUTOMATION_SUBMIT_CLI_PRINCIPAL,
      grant: AUTOMATION_SUBMIT_CLI_GRANT,
      source: Object.freeze({ id: source.id, sha256: source.sha256 }),
      operation: automationApiSelection(context), idempotencyKey: key,
    }));
    return Object.freeze({ source, queued: Object.freeze({ job: receipt.job, idempotent: receipt.idempotent }) });
  } catch (error) {
    if (!admissionMayBeDurable(error)) await automation.sources.discardCreated(source);
    throw error;
  }
}

export async function runSingleSubmissionCommand(application, automation, command, stdout, runtime, signal) {
  const context = createSubmissionContext(command);
  if (!automation.api || typeof automation.api.submit !== 'function' || !isAutomationApiRepresentable(context)) {
    const submitted = await submitSingleDocument(application, automation, command, runtime, signal, context);
    const request = enqueueSubmissionRequest(automation, submitted.source, context);
    await runtime.outputValue(command, stdout, Object.freeze({ operation: request.type,
      source: { id: submitted.source.id, sha256: submitted.source.sha256, size: submitted.source.size },
      job: submitted.queued.job, idempotent: submitted.queued.idempotent }));
    return;
  }
  const document = await runtime.uploadPdf(application, command.input, signal);
  try {
    const submitted = await serializeSubmission(application, () => (
      submitThroughApi(application, automation, document, context, command.idempotencyKey, runtime, signal)
    ));
    await runtime.outputValue(command, stdout, Object.freeze({ operation: submitted.queued.job.type,
      source: { id: submitted.source.id, sha256: submitted.source.sha256, size: submitted.source.size },
      job: submitted.queued.job, idempotent: submitted.queued.idempotent }), signal);
  } finally { await application.store.deleteDocument(document.id); }
}
