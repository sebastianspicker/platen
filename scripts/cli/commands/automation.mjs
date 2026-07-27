import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { HostError } from '../../host/host-error.mjs';
import { automationPresetDescriptor } from '../../host/automation/automation-operation-contract.mjs';

const submissionOperations = new WeakMap();

function serializeSubmission(application, operation) {
  const previous = submissionOperations.get(application) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  submissionOperations.set(application, current);
  void current.finally(() => {
    if (submissionOperations.get(application) === current) {
      submissionOperations.delete(application);
    }
  }).catch(() => {});
  return current;
}

function requireAutomation(application) {
  if (!application.automation) {
    const error = new Error('Automation commands require an explicit private --automation-root.');
    error.code = 'AUTOMATION_ROOT_REQUIRED';
    throw error;
  }
  return application.automation;
}

function matchingInspectJob(job, sha256) {
  return job?.type === 'automation_inspect_v1'
    && job.payload?.sha256 === sha256
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '');
}

function matchingOcrJob(job, sha256, options) {
  return job?.type === 'automation_ocr_v1'
    && job.payload?.sha256 === sha256
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '')
    && job.payload?.language === options.language
    && job.payload?.cleanupPreset === options.cleanupPreset
    && job.payload?.segmentation === options.segmentation
    && JSON.stringify(job.payload?.userDictionary) === JSON.stringify(options.userDictionary);
}

function matchingOutputIntentJob(job, sha256) {
  return job?.type === 'automation_output_intent_v1'
    && job.payload?.sha256 === sha256
    && job.payload?.profile === 'local-ghostscript-default-cmyk-output-intent-v1'
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '');
}

function matchingFullPageRedactionJob(job, sha256, pages) {
  return job?.type === 'automation_full_page_redaction_v1'
    && job.payload?.sha256 === sha256
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '')
    && JSON.stringify(job.payload?.pages) === JSON.stringify(pages);
}

function matchingPresetJob(job, sha256, preset) {
  let descriptor;
  try { descriptor = automationPresetDescriptor(preset); } catch { return false; }
  return job?.type === descriptor.type
    && job.payload?.preset === preset
    && job.payload?.sha256 === sha256
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '');
}
function matchingSequenceJob(job, sha256, sequence) {
  return job?.type === 'automation_sequence_v1'
    && job.payload?.sha256 === sha256
    && job.payload?.sequenceId === sequence
    && job.payload?.sequenceVersion === 1
    && /^[A-Za-z0-9_-]{1,128}$/u.test(job.payload?.sourceId ?? '');
}

async function existingSubmission(automation, admission, document, matcher) {
  if (!matcher(admission.existing, document.sha256)) {
    throw new HostError(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key belongs to a different job request.',
      409,
    );
  }
  const opened = await automation.sources.openVerified(
    admission.existing.payload.sourceId,
    document.sha256,
  );
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
    options.language,
    options.cleanupPreset,
    options.segmentation,
    options.userDictionary,
  ])).digest('hex');
  return `ocr-${document.sha256}-${digest}`;
}

function defaultFullPageRedactionIdempotencyKey(document, pages) {
  const digest = createHash('sha256').update(JSON.stringify(pages)).digest('hex');
  return `full-page-redaction-${document.sha256}-${digest}`;
}

async function verifiedOutputBytes(sources, outputId, sha256, runtime, signal) {
  const opened = await sources.openOutputVerified(outputId, sha256);
  const chunks = [];
  let size = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of opened.stream) {
      runtime.cancelled(signal);
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > opened.size) {
        throw new HostError('AUTOMATION_OUTPUT_CORRUPT', 'Automation output exceeded its verified size.', 500);
      }
      hash.update(bytes);
      chunks.push(bytes);
    }
    runtime.cancelled(signal);
    if (size !== opened.size || hash.digest('hex') !== opened.sha256) {
      throw new HostError('AUTOMATION_OUTPUT_CORRUPT', 'Automation output changed while it was copied.', 500);
    }
    return Object.freeze({ metadata: Object.freeze({
      id: opened.id,
      sha256: opened.sha256,
      size: opened.size,
      sourceId: opened.sourceId,
      sourceSha256: opened.sourceSha256,
    }), bytes: Buffer.concat(chunks, size) });
  } finally {
    opened.stream.destroy();
  }
}

async function runOutputCommand(automation, command, stdout, runtime, signal) {
  if (command.command === 'automation-output-list') {
    const outputs = await automation.sources.listOutputs();
    await runtime.outputValue(command, stdout, Object.freeze({
      count: outputs.length,
      outputs,
      localOnly: true,
    }), signal);
    return true;
  }
  if (command.command === 'automation-output-copy') {
    const verified = await verifiedOutputBytes(
      automation.sources, command.outputId, command.sha256, runtime, signal,
    );
    await runtime.writeExclusive(command.output, verified.bytes, signal);
    await runtime.emit(stdout, Object.freeze({
      copied: true,
      output: verified.metadata,
      localOnly: true,
    }));
    return true;
  }
  if (command.command === 'automation-output-delete') {
    const deleted = await automation.sources.deleteOutput(command.outputId, command.sha256);
    await runtime.outputValue(command, stdout, Object.freeze({
      deleted: true,
      output: deleted,
      localOnly: true,
    }), signal);
    return true;
  }
  return false;
}

function submissionContext(command) {
  const isSequence = command.command === 'automation-submit-sequence';
  const operation = command.command === 'automation-submit'
    ? command.operation
    : command.command === 'automation-submit-ocr'
      ? 'ocr'
      : command.command === 'automation-submit-output-intent'
        ? 'output-intent'
        : command.command === 'automation-submit-full-page-redaction'
          ? 'full-page-redaction' : 'inspect';
  const isOcr = operation === 'ocr';
  const isOutputIntent = operation === 'output-intent';
  const isFullPageRedaction = operation === 'full-page-redaction';
  const isPreset = command.command === 'automation-submit' && command.preset !== undefined;
  const options = isOcr ? Object.freeze({
    language: command.language ?? 'eng',
    cleanupPreset: command.cleanupPreset ?? 'document',
    segmentation: command.segmentation ?? 'auto',
    userDictionary: command.userDictionary ?? [],
  }) : null;
  const matcher = isSequence
    ? (job, sha256) => matchingSequenceJob(job, sha256, command.sequence)
    : isPreset
    ? (job, sha256) => matchingPresetJob(job, sha256, command.preset)
    : isOcr
    ? (job, sha256) => matchingOcrJob(job, sha256, options)
    : isOutputIntent
      ? (job, sha256) => matchingOutputIntentJob(job, sha256)
      : isFullPageRedaction
        ? (job, sha256) => matchingFullPageRedactionJob(job, sha256, command.pages)
        : (job, sha256) => matchingInspectJob(job, sha256);
  return Object.freeze({
    isOcr, isOutputIntent, isFullPageRedaction, isPreset, isSequence, sequence: command.sequence ?? null, preset: command.preset ?? null, options,
    operation,
    pages: isFullPageRedaction ? command.pages : null,
    matcher,
  });
}

function enqueueRequest(automation, source, context) {
  if (context.isSequence) return automation.registry.enqueueSequenceRequest(source, context.sequence);
  if (context.isPreset) return automation.registry.enqueuePresetRequest(source, context.preset);
  if (context.isOcr) return automation.registry.enqueueOcrRequest(source, context.options);
  if (context.isOutputIntent) return automation.registry.enqueueOutputIntentRequest(source);
  if (context.isFullPageRedaction) {
    return automation.registry.enqueueFullPageRedactionRequest(source, { pages: context.pages });
  }
  return automation.registry.enqueueRequest(source);
}

async function stageSubmission(application, automation, document, context, command, runtime, signal) {
  let source; let queued;
  await serializeSubmission(application, async () => {
    runtime.cancelled(signal);
    const idempotencyKey = command.idempotencyKey
      ?? (context.isPreset
        ? `preset-${document.sha256}-${context.preset}`
        : context.isOcr
        ? defaultOcrIdempotencyKey(document, context.options)
        : context.isFullPageRedaction
          ? defaultFullPageRedactionIdempotencyKey(document, context.pages)
        : context.isSequence
          ? `sequence-${document.sha256}-${context.sequence}-1`
          : `${context.isOutputIntent ? 'output-intent' : 'inspect'}-${document.sha256}`);
    const admission = await automation.queue.admission(idempotencyKey);
    runtime.cancelled(signal);
    if (admission.existing) {
      ({ source, queued } = await existingSubmission(
        automation, admission, document, context.matcher,
      ));
      return;
    }
    if (!admission.accepting) throw new HostError('QUEUE_FULL', 'The durable queue is full.', 429);
    try {
      source = await automation.sources.stageDocument({
        store: application.store, documentId: document.id, signal,
      });
    } catch (error) {
      if (signal?.aborted) runtime.cancelled(signal);
      throw error;
    }
    const request = enqueueRequest(automation, source, context);
    try {
      runtime.cancelled(signal);
      queued = await automation.queue.enqueue({
        ...request,
        idempotencyKey,
        transaction: {
          kind: 'source', id: source.id, sha256: source.sha256, size: source.size,
          sourceId: source.id, sourceSha256: source.sha256,
        },
      });
      await automation.sources.commit(source);
    } catch (error) {
      const after = await automation.queue.admission(idempotencyKey).catch(() => null);
      if (after && context.matcher(after.existing, source.sha256)
        && after.existing.payload.sourceId === source.id) {
        await automation.sources.commit(source);
        queued = Object.freeze({ job: after.existing, idempotent: true });
      } else {
        if (after) await automation.sources.discardCreated(source);
        throw error;
      }
    }
  });
  return Object.freeze({ source, queued });
}

async function runSubmissionCommand(application, automation, command, stdout, runtime, signal) {
  const context = submissionContext(command);
  const document = await runtime.uploadPdf(application, command.input, signal);
  let submitted;
  try {
    submitted = await stageSubmission(
      application, automation, document, context, command, runtime, signal,
    );
  } finally { await application.store.deleteDocument(document.id); }
  const request = enqueueRequest(automation, submitted.source, context);
  await runtime.outputValue(command, stdout, Object.freeze({
    operation: request.type,
    source: {
      id: submitted.source.id, sha256: submitted.source.sha256, size: submitted.source.size,
    },
    job: submitted.queued.job, idempotent: submitted.queued.idempotent,
  }));
}

async function runQueueCommand(automation, command, stdout, runtime, signal) {
  if (command.command === 'automation-run') {
    await runtime.outputValue(command, stdout, await automation.worker.runOnce({ signal }));
    return true;
  }
  if (command.command === 'automation-status') {
    const job = await automation.queue.get(command.jobId);
    await runtime.outputValue(command, stdout, Object.freeze({ job, receipt: job.receipt }));
    return true;
  }
  if (command.command === 'automation-cancel') {
    const job = await automation.worker.cancel(command.jobId);
    await runtime.outputValue(command, stdout, Object.freeze({ job, receipt: job.receipt }));
    return true;
  }
  return false;
}

export async function runAutomationCommand(application, command, stdout, runtime, signal) {
  const automation = requireAutomation(application);
  runtime.cancelled(signal);
  if (await runOutputCommand(automation, command, stdout, runtime, signal)) return;
  if (['automation-submit', 'automation-submit-inspect', 'automation-submit-ocr',
    'automation-submit-output-intent', 'automation-submit-full-page-redaction', 'automation-submit-sequence'].includes(command.command)) {
    await runSubmissionCommand(application, automation, command, stdout, runtime, signal);
    return;
  }
  if (await runQueueCommand(automation, command, stdout, runtime, signal)) return;
  throw new Error(`Unsupported automation command: ${basename(command.command)}.`);
}
