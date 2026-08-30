import { createHash } from 'node:crypto';
import { createSubmissionContext, enqueueSubmissionRequest, submitSingleDocument } from './automation-submission.mjs';

function requireAutomation(application) {
  if (!application.automation) {
    const error = new Error('Automation commands require an explicit private --automation-root.');
    error.code = 'AUTOMATION_ROOT_REQUIRED';
    throw error;
  }
  return application.automation;
}

function batchIdentityHash(identity) {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function itemIdentity(identity, ordinal) {
  const digest = createHash('sha256')
    .update('platen:automation-submit-batch:v1\0', 'utf8')
    .update(identity, 'utf8')
    .update(`\0${ordinal}`, 'utf8')
    .digest('hex');
  return `automation-submit-batch-v1-${digest}`;
}

function itemReceipt(submitted, request, ordinal) {
  return Object.freeze({
    ordinal,
    operation: request.type,
    source: Object.freeze({ id: submitted.source.id, sha256: submitted.source.sha256, size: submitted.source.size }),
    job: Object.freeze({ id: submitted.queued.job.id, type: submitted.queued.job.type, status: submitted.queued.job.status }),
    idempotent: submitted.queued.idempotent,
  });
}

function itemCommand(command, input) {
  return Object.freeze({ ...command, command: 'automation-submit', input });
}

export async function runAutomationCliBatchCommand(application, command, stdout, runtime, signal) {
  if (command.command !== 'automation-submit-batch') return false;
  const automation = requireAutomation(application);
  const identityHash = batchIdentityHash(command.idempotencyKey);
  const context = createSubmissionContext(Object.freeze({ ...command, command: 'automation-submit' }));
  const items = [];
  for (let index = 0; index < command.inputs.length; index += 1) {
    runtime.cancelled(signal);
    const single = itemCommand(command, command.inputs[index]);
    const submitted = await submitSingleDocument(application, automation, single, runtime, signal, context, itemIdentity(command.idempotencyKey, index + 1));
    items.push(itemReceipt(submitted, enqueueSubmissionRequest(automation, submitted.source, context), index + 1));
  }
  await runtime.outputValue(command, stdout, Object.freeze({
    batchIdentityHash: identityHash, count: items.length, localOnly: true, items: Object.freeze(items),
  }), signal);
  return true;
}
