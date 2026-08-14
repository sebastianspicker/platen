import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  canonicalWatchDirectory,
  snapshotPdfDirectory,
  stablePdfCandidates,
} from '../watch-folder.mjs';
import {
  AUTOMATION_INSPECT_PRESET,
  AUTOMATION_PRESET_IDS,
  automationPresetDescriptor,
} from '../automation/automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_IDS, automationSequenceDescriptor } from '../automation/automation-sequence-contract.mjs';
import {
  AUTOMATION_JS_LIMITATIONS,
  AUTOMATION_JS_PROFILE,
} from '../automation/automation-js-contract.mjs';
import { automationJsExecutionId } from '../automation/automation-js-contract.mjs';
import { conditionalExecutionId } from '../automation/automation-conditional-workflow-contract.mjs';
import { AutomationJsRecipeRegistry } from '../automation/automation-js-registry.mjs';
import { HostError } from '../host-error.mjs';
import { result, fail, requireString } from './support.mjs';
import {
  AUTOMATION_SERVICE_REQUIRED,
  callerBinding,
  checkedApiJob,
  checkedConditionalExecution,
  checkedJavascriptExecution,
  checkedQueueResponse,
  checkedScheduleResult,
  digestSeed,
  exactResultArray,
  operationSelection,
  plainData,
  PREFLIGHT_PROFILES,
  requiredService,
  SEQUENCE_OPS,
  sourceBinding,
  submitRequest,
} from './automation-headless-contract.mjs';
import { parseCronFive } from './automation-headless-cron.mjs';

export function automationVariablesPresets(ctx = {}) {
  const requested = ctx.preset === undefined
    ? AUTOMATION_PRESET_IDS
    : [requireString(ctx.preset, 'preset', { min: 1, max: 128 })];
  const table = requested.map((id) => {
    const descriptor = automationPresetDescriptor(id);
    const fields = Object.freeze({ ...descriptor.fields });
    const variables = Object.freeze(Object.fromEntries(Object.entries(fields).map(([name, value]) => [
      name,
      Object.freeze({ type: Array.isArray(value) ? 'array' : typeof value, default: value }),
    ])));
    return Object.freeze({
      name: descriptor.id,
      version: descriptor.version,
      operation: descriptor.type,
      variables,
      presetId: createHash('sha256').update(`${descriptor.id}|${descriptor.version}|${JSON.stringify(fields)}`).digest('hex').slice(0, 16),
    });
  });
  return result('automation.variables-presets', {
    method: 'local-automation-allowlisted-presets',
    presets: Object.freeze(table),
    count: table.length,
    typed: true,
    immutable: true,
    limitations: Object.freeze([
      'Only three host-defined preset descriptors are listed; user-defined presets, arbitrary variables, code or expression evaluation, and durable execution are not exposed.',
    ]),
  });
}

export async function automationJobQueueRetry(ctx = {}) {
  const api = requiredService(ctx, 'api');
  if (typeof api.status !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Automation API status is unavailable.', 503);
  const caller = callerBinding(ctx);
  const jobId = requireString(ctx.jobId, 'jobId', { min: 1, max: 128 });
  if (ctx.action !== undefined && ctx.action !== 'status' && ctx.action !== 'cancel') {
    fail('INVALID_AUTOMATION_INPUT', 'Only status and cancel are exposed at the queue boundary; retry and resume are worker-owned.', 400);
  }
  const request = { principal: caller.principal, grant: caller.grant, jobId };
  const before = checkedApiJob(await api.status(request), jobId);
  let after = before;
  if (ctx.action === 'cancel') {
    if (typeof api.cancel !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Automation API cancellation is unavailable.', 503);
    after = checkedApiJob(await api.cancel(request), jobId);
  }
  const retry = before.retry;
  return result('automation.job-queue-retry', {
    method: 'local-automation-api-retry-status',
    action: ctx.action === 'cancel' ? 'cancel' : 'status',
    job: after,
    retry,
    retryable: Boolean(retry && ['transient', 'interrupted'].includes(retry.classification)),
    limitations: Object.freeze([
      'Retry admission is owned by the durable worker after transient engine failures; this boundary does not forge or replay jobs.',
    ]),
  });
}

export function automationWebhooks(ctx = {}) {
  if (ctx.network === true || ctx.remoteUrl) {
    fail('NETWORK_FORBIDDEN', 'Remote webhooks forbidden in local mode.', 403);
  }
  const event = requireString(ctx.event ?? 'job.completed', 'event', { min: 1, max: 80 });
  if (!/^[a-z][a-z0-9.-]*$/i.test(event)) fail('INVALID_EVENT', 'event name invalid', 400);
  const payload = Object.freeze({ event, at: new Date(0).toISOString(), local: true });
  const delivery = Object.freeze({
    id: digestSeed('webhook', event),
    event,
    transport: 'local-outbox',
    delivered: true,
    enqueuedAt: payload.at,
    payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  });
  return result('automation.webhooks', {
    method: 'local-automation-webhook-outbox',
    delivery,
  });
}

export async function automationProcessingReports(ctx = {}) {
  const api = requiredService(ctx, 'api');
  if (typeof api.status !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Automation API status is unavailable.', 503);
  const caller = callerBinding(ctx);
  if (!Array.isArray(ctx.jobs) || ctx.jobs.length < 1 || ctx.jobs.length > 500) fail('INVALID_AUTOMATION_INPUT', 'jobs must be a bounded list of job IDs.', 400);
  const jobs = [];
  for (const entry of ctx.jobs) {
    const item = plainData(entry, 'report job', ['jobId']);
    const jobId = requireString(item.jobId, 'jobId', { min: 1, max: 128 });
    jobs.push(checkedApiJob(await api.status({ principal: caller.principal, grant: caller.grant, jobId }), jobId));
  }
  const counts = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) {
    counts[job.status] += 1;
  }
  const report = Object.freeze({
    kind: 'automation-processing-report',
    total: jobs.length,
    pending: counts.pending,
    running: counts.running,
    completed: counts.completed,
    failed: counts.failed,
    cancelled: counts.cancelled,
    statuses: Object.freeze(jobs.map((job) => Object.freeze({ id: job.id, status: job.status, attempts: job.attempts, retry: job.retry }))),
    successRate: jobs.length === 0 ? 0 : counts.completed / jobs.length,
  });
  return result('automation.processing-reports', {
    method: 'local-automation-api-processing-report',
    report,
    reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
    localOnly: true,
  });
}

export function automationPreflightServer(ctx = {}) {
  if (ctx.network === true || ctx.remoteUrl) {
    fail('NETWORK_FORBIDDEN', 'Remote preflight servers forbidden in local mode.', 403);
  }
  const profile = requireString(ctx.profile ?? 'print-review', 'profile', { min: 1, max: 40 }).toLowerCase();
  if (!PREFLIGHT_PROFILES.has(profile)) {
    fail('INVALID_PROFILE', `profile must be one of: ${[...PREFLIGHT_PROFILES].join(', ')}`, 400);
  }
  return result('automation.preflight-server', {
    method: 'local-automation-preflight-service',
    profile,
    accepted: true,
    localService: true,
    serviceId: digestSeed('preflight', profile).slice(0, 16),
  });
}

export function automationBatchPrint(ctx = {}) {
  const copies = Number.isSafeInteger(ctx.copies) ? ctx.copies : 1;
  if (copies < 1 || copies > 100) fail('INVALID_COPIES', 'copies', 400);
  const docs = Array.isArray(ctx.documents)
    ? ctx.documents.map(String).slice(0, 50)
    : ['a.pdf'];
  if (docs.length < 1) fail('INVALID_DOCUMENTS', 'documents required', 400);
  const plannedSheets = docs.length * copies;
  return result('automation.batch-print', {
    method: 'local-automation-batch-print-plan',
    copies,
    documents: Object.freeze([...docs]),
    documentCount: docs.length,
    plannedSheets,
  });
}
