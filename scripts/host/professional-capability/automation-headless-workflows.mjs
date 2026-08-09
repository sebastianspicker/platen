import { createHash, randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  canonicalWatchDirectory,
  snapshotPdfDirectory,
  stablePdfCandidates,
} from '../watch-folder.mjs';
import {
  AUTOMATION_OPERATION_IDS,
  publicAutomationApiReceipt,
  normalizeAutomationApiSubmitRequest,
} from '../automation/automation-api-contract.mjs';
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
  AUTOMATION_JS_RECIPE_IDS,
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
  requiredService,
  sourceBinding,
  submitRequest,
} from './automation-headless-contract.mjs';

export async function automationWatchFolders(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Network side effects require adapter injection.', 403);
  if (typeof ctx.directory !== 'string' || !ctx.directory) {
    fail('WATCH_DIRECTORY_REQUIRED', 'An existing private watch directory is required.', 400);
  }
  const dir = await canonicalWatchDirectory(ctx.directory);
  const records = await snapshotPdfDirectory(dir, { maxEntries: 64, maxPdfFiles: 32 });
  const previous = Array.isArray(ctx.previousRecords) ? ctx.previousRecords.map((entry) => {
    const item = plainData(entry, 'previous watch record', ['name', 'path', 'size', 'signature']);
    if (typeof item.name !== 'string' || typeof item.path !== 'string'
      || !Number.isSafeInteger(item.size) || typeof item.signature !== 'string') {
      fail('INVALID_AUTOMATION_INPUT', 'previous watch record values are invalid.', 400);
    }
    return item;
  }) : [];
  const processedEntries = Array.isArray(ctx.processed) ? ctx.processed : [];
  const processed = new Map();
  for (const entry of processedEntries) {
    const item = plainData(entry, 'processed watch state', ['name', 'signature']);
    processed.set(item.name, item.signature);
  }
  const candidates = stablePdfCandidates(previous, records, processed, 32);
  return result('automation.watch-folders', {
    method: 'local-watch-folder-stability-boundary',
    directory: dir,
    records,
    candidates,
    count: records.length,
    processable: false,
    limitations: Object.freeze([
      'This professional path discovers stable local PDF candidates; a worker must explicitly submit each candidate.',
      'No filesystem watcher, network delivery, or implicit processing is started by this handler.',
    ]),
  });
}

export async function automationActionSequences(ctx = {}) {
  const api = requiredService(ctx, 'api');
  if (typeof api.submit !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Automation API submission is unavailable.', 503);
  const sequence = requireString(ctx.sequence ?? AUTOMATION_SEQUENCE_IDS[0], 'sequence', { min: 1, max: 128 });
  const descriptor = automationSequenceDescriptor(sequence);
  const request = submitRequest(ctx, operationSelection('sequence', descriptor.id), `sequence-${descriptor.id}`);
  const queued = checkedQueueResponse(await api.submit(request), 'automation_sequence_v1');
  return result('automation.action-sequences', {
    method: 'local-automation-sequence-api',
    sequence: descriptor,
    job: queued.job,
    idempotent: queued.idempotent,
    source: request.source,
    sourceBound: true,
    limitations: Object.freeze([
      'Only immutable host-defined sequences are admitted; arbitrary recording and editing are not exposed.',
      'Submission queues the sequence. Execution remains an explicit worker action.',
    ]),
  });
}

export async function automationJavascript(ctx = {}) {
  const service = requiredService(ctx, 'automationJs');
  if (typeof service.execute !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Declarative automation recipe execution is unavailable.', 503);
  const caller = callerBinding(ctx);
  const source = sourceBinding(ctx);
  const recipeId = requireString(ctx.recipeId ?? 'inspect-document-v1', 'recipeId', { min: 1, max: 64 });
  if (!AUTOMATION_JS_RECIPE_IDS.includes(recipeId)) {
    fail('AUTOMATION_JS_RECIPE_DENIED', 'Declarative recipe is not allowlisted.', 403);
  }
  const repeat = Number.isSafeInteger(ctx.repeat) ? ctx.repeat : 1;
  if (repeat < 1 || repeat > 4) fail('INVALID_AUTOMATION_INPUT', 'repeat must be within the fixed recipe bound.', 400);
  const idempotencyKey = requireString(ctx.idempotencyKey ?? `javascript-${recipeId}-${source.sha256}`, 'idempotencyKey', { min: 1, max: 256 });
  const request = {
    profile: AUTOMATION_JS_PROFILE,
    principal: caller.principal,
    grant: caller.grant,
    source,
    recipe: { id: recipeId, version: 1, repeat },
    idempotencyKey,
  };
  const execution = checkedJavascriptExecution(
    await service.execute(request, { signal: ctx.signal ?? null }), request,
  );
  return result('automation.javascript', {
    method: 'local-automation-declarative-recipe-service',
    execution,
    source,
    sourceBound: true,
    javascriptExecuted: false,
  });
}

export async function automationScheduledJobs(ctx = {}) {
  const service = requiredService(ctx, 'scheduledJobs');
  if (typeof service.create !== 'function' || typeof service.start !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Scheduled automation service is unavailable.', 503);
  const caller = callerBinding(ctx);
  const source = sourceBinding(ctx);
  const scheduleId = requireString(ctx.scheduleId, 'scheduleId', { min: 1, max: 128 });
  if (!Number.isSafeInteger(ctx.firstAt) || ctx.firstAt < 0) fail('INVALID_AUTOMATION_INPUT', 'firstAt must be a non-negative UTC epoch.', 400);
  const operationId = requireString(ctx.operationId ?? AUTOMATION_INSPECT_PRESET, 'operationId', { min: 1, max: 128 });
  const kind = ctx.operationKind === 'sequence' ? 'sequence' : 'preset';
  if (kind === 'preset') automationPresetDescriptor(operationId);
  else automationSequenceDescriptor(operationId);
  const request = {
    principal: caller.principal, grant: caller.grant, scheduleId, source,
    operation: operationSelection(kind, operationId), firstAt: ctx.firstAt,
    intervalMs: ctx.intervalMs ?? null,
  };
  const tickRequested = ctx.tickAt !== undefined;
  if (tickRequested && (!Number.isSafeInteger(ctx.tickAt) || ctx.tickAt < 0)) {
    fail('INVALID_AUTOMATION_INPUT', 'tickAt must be a non-negative UTC epoch.', 400);
  }
  if (tickRequested && typeof service.tick !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Scheduled automation ticking is unavailable.', 503);
  if (ctx.start !== false && typeof service.delete !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Scheduled automation rollback is unavailable.', 503);
  const schedule = checkedScheduleResult(await service.create(request), request);
  let ticked = [];
  try {
    if (ctx.start !== false) await service.start();
    if (tickRequested) {
      const rawTicked = await service.tick(ctx.tickAt);
      ticked = exactResultArray(rawTicked, 'Ticked schedules', 256)
        .map((entry) => checkedScheduleResult(entry, request));
      ticked = Object.freeze(ticked);
    }
  } catch (error) {
    try {
      await service.delete({ principal: caller.principal, grant: caller.grant, scheduleId });
    } catch (rollbackError) {
      throw new HostError('AUTOMATION_SCHEDULE_ROLLBACK_FAILED', 'Schedule post-create work failed and rollback did not complete.', 500, { cause: new AggregateError([error, rollbackError]) });
    }
    throw error;
  }
  return result('automation.scheduled-jobs', {
    method: 'local-automation-schedule-service',
    schedule,
    ticked,
    source,
    sourceBound: true,
  });
}

export async function automationConditionalWorkflows(ctx = {}) {
  const service = requiredService(ctx, 'conditionalWorkflows');
  if (typeof service.execute !== 'function') fail(AUTOMATION_SERVICE_REQUIRED, 'Conditional workflow service is unavailable.', 503);
  const caller = callerBinding(ctx);
  const source = sourceBinding(ctx);
  const workflow = plainData(ctx.workflow, 'workflow', ['steps', 'workflowId']);
  const idempotencyKey = requireString(ctx.idempotencyKey ?? `conditional-${source.sha256}`, 'idempotencyKey', { min: 1, max: 96 });
  const request = {
    principal: caller.principal, grant: caller.grant, source, workflow, idempotencyKey,
  };
  const execution = checkedConditionalExecution(
    await service.execute(request, { signal: ctx.signal ?? null }), request,
  );
  return result('automation.conditional-workflows', {
    method: 'local-automation-conditional-service',
    execution,
    source,
    sourceBound: true,
  });
}

