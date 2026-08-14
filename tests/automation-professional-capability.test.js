import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { AutomationSourceStore } from '../scripts/host/automation/automation-source-store.mjs';
import { DurableLocalJobQueue } from '../scripts/host/automation/durable-local-job-queue.mjs';
import { AutomationOperationRegistry } from '../scripts/host/automation/automation-operation-registry.mjs';
import { AutomationApiService } from '../scripts/host/automation/automation-api-service.mjs';
import { AutomationJsService } from '../scripts/host/automation/automation-js-service.mjs';
import { AutomationScheduledJobsService } from '../scripts/host/automation/automation-scheduled-jobs-service.mjs';
import { AutomationScheduleStore } from '../scripts/host/automation/automation-scheduled-jobs-store.mjs';
import { AutomationConditionalWorkflowService } from '../scripts/host/automation/automation-conditional-workflow-service.mjs';
import {
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_INSPECT_PRESET,
} from '../scripts/host/automation/automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_TYPE } from '../scripts/host/automation/automation-sequence-contract.mjs';
import { AUTOMATION_JS_PROFILE } from '../scripts/host/automation/automation-js-contract.mjs';
import { handlers } from '../scripts/host/professional-capability/automation-headless.mjs';

const PRINCIPAL = 'caller.one';
const GRANT = Object.freeze({ grantId: 'grant_local_1', principal: PRINCIPAL });

class LocalAutomationAuthority {
  #revoked = false;
  #pauseAction = null;
  #paused = null;
  #release = null;

  pause(action) {
    this.#pauseAction = action;
    this.#paused = new Promise((resolve) => { this.#release = resolve; });
  }

  release() {
    this.#pauseAction = null;
    this.#release?.();
    this.#release = null;
  }

  revoke() { this.#revoked = true; }

  get paused() { return this.#paused; }

  async authorize(grant, context) {
    if (grant?.principal !== PRINCIPAL || grant?.grantId !== GRANT.grantId) {
      throw new HostError('AUTOMATION_CAPABILITY_DENIED', 'The local automation grant is not valid.', 403);
    }
    if (this.#revoked) throw new HostError('AUTOMATION_CAPABILITY_DENIED', 'The local automation grant was revoked.', 403);
    if (context.action === this.#pauseAction) await this.#paused;
    if (this.#revoked) throw new HostError('AUTOMATION_CAPABILITY_DENIED', 'The local automation grant was revoked.', 403);
    return true;
  }
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-automation-professional-'));
  const automationRoot = join(root, 'automation');
  await mkdir(automationRoot, { mode: 0o700 });
  const store = await new DocumentStore({ root: join(root, 'documents') }).initialize();
  const bytes = createBlankPdf({ pages: 1 });
  const document = await store.createDocument({
    stream: Readable.from([bytes]), displayName: 'source.pdf', mediaType: 'application/pdf',
  });
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const staged = await sources.stageDocument({ store, documentId: document.id });
  await sources.commit(staged);
  const source = Object.freeze({ id: staged.id, sha256: staged.sha256 });
  const authority = new LocalAutomationAuthority();
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'),
    allowedJobTypes: [
      'automation_inspect_v1', 'automation_ocr_v1', 'automation_output_intent_v1',
      'automation_full_page_redaction_v1', AUTOMATION_SEQUENCE_TYPE,
    ],
  }).initialize();
  const registry = new AutomationOperationRegistry();
  const api = new AutomationApiService({
    queue, registry, sources, authority, sleep: async () => {},
  });
  const automationJs = new AutomationJsService({ api, authority });
  const scheduleStore = await new AutomationScheduleStore({ root: join(automationRoot, 'schedules') }).initialize();
  const scheduledJobs = new AutomationScheduledJobsService({
    store: scheduleStore, api, authority, clock: () => 1_000,
  });
  const conditionalWorkflows = new AutomationConditionalWorkflowService({
    api,
    authority,
    factsProvider: {
      async inspectVerified(binding) {
        return Object.freeze({
          source: Object.freeze({ id: binding.id, sha256: binding.sha256 }),
          pageCount: 1, encrypted: false, tagged: false, optimized: false,
        });
      },
    },
  });
  const automation = Object.freeze({ api, automationJs, scheduledJobs, conditionalWorkflows });
  const context = Object.freeze({ source, principal: PRINCIPAL, grant: GRANT, automation });
  t.after(async () => {
    authority.release();
    await conditionalWorkflows.close().catch(() => {});
    await automationJs.close().catch(() => {});
    await scheduledJobs.close().catch(() => {});
    await queue.close().catch(() => {});
    await store.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, authority, queue, api, automationJs, scheduledJobs, conditionalWorkflows, context };
}

function sequenceRequest(context, overrides = {}) {
  return {
    ...context, sequence: 'inspect-then-ocr-english-v1', idempotencyKey: `sequence-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

test('action sequences use the real source store and API service with immutable binding', async (t) => {
  const state = await setup(t);
  const outcome = await handlers['automation.action-sequences'](sequenceRequest(state.context));
  assert.equal(outcome.sourceBound, true);
  assert.equal(outcome.job.type, AUTOMATION_SEQUENCE_TYPE);
  assert.equal(outcome.job.attempts, 0);
  await assert.rejects(() => handlers['automation.action-sequences'](sequenceRequest(state.context, {
    source: { id: '../escape', sha256: 'b'.repeat(64) },
  })), { code: 'INVALID_AUTOMATION_INPUT' });
});

test('forged queue, JS, conditional, schedule, and report results fail closed', async (t) => {
  const state = await setup(t);
  const forgedApi = new Proxy(state.api, {
    get(target, property, receiver) {
      if (property === 'submit') return async () => ({ schemaVersion: 1, idempotent: false, job: { id: 'job_1', type: 'automation_inspect_v1', status: 'pending' } });
      if (property === 'status') return async () => ({ id: 'job_1', type: 'automation_inspect_v1', status: 'pending' });
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(() => handlers['automation.action-sequences'](sequenceRequest({ ...state.context, automation: { ...state.automation, api: forgedApi } })), { code: 'AUTOMATION_RESULT_INVALID' });

  const forgedJs = new Proxy(state.automationJs, { get(target, property, receiver) {
    if (property === 'execute') return async () => ({ schemaVersion: 1, status: 'completed', javascriptExecuted: false });
    return Reflect.get(target, property, receiver);
  } });
  await assert.rejects(() => handlers['automation.javascript']({ ...state.context, automation: { ...state.automation, automationJs: forgedJs }, recipeId: 'inspect-document-v1' }), { code: 'AUTOMATION_RESULT_INVALID' });

  const forgedConditional = new Proxy(state.conditionalWorkflows, { get(target, property, receiver) {
    if (property === 'execute') return async () => ({ schemaVersion: 1, status: 'completed' });
    return Reflect.get(target, property, receiver);
  } });
  const workflow = { workflowId: 'workflow_1', steps: [{
    stepId: 'step_1', condition: { field: 'document.pageCount', operator: 'gte', value: 1 },
    trueBranch: { operation: null, repeat: 1 },
    falseBranch: { operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }, repeat: 1 },
  }] };
  await assert.rejects(() => handlers['automation.conditional-workflows']({ ...state.context, automation: { ...state.automation, conditionalWorkflows: forgedConditional }, workflow }), { code: 'AUTOMATION_RESULT_INVALID' });

  const forgedSchedule = new Proxy(state.scheduledJobs, { get(target, property, receiver) {
    if (property === 'create') return async () => ({ scheduleId: 'forged' });
    return Reflect.get(target, property, receiver);
  } });
  await assert.rejects(() => handlers['automation.scheduled-jobs']({ ...state.context, automation: { ...state.automation, scheduledJobs: forgedSchedule }, scheduleId: 'forged', firstAt: 1_000 }), { code: 'AUTOMATION_RESULT_INVALID' });

  await assert.rejects(() => handlers['automation.processing-reports']({ ...state.context, automation: { ...state.automation, api: forgedApi }, jobs: [{ jobId: 'job_1' }] }), { code: 'AUTOMATION_RESULT_INVALID' });
});

test('declarative JavaScript uses the genuine fixed recipe contract', async (t) => {
  const state = await setup(t);
  const outcome = await handlers['automation.javascript']({ ...state.context, recipeId: 'inspect-document-v1', repeat: 1 });
  assert.equal(outcome.javascriptExecuted, false);
  assert.equal(outcome.execution.source.sha256, state.source.sha256);
  assert.equal(outcome.execution.queuedCount, 1);
  assert.equal(outcome.execution.jobs[0].type, AUTOMATION_INSPECT_TYPE);
  await assert.rejects(() => handlers['automation.javascript']({ ...state.context, recipeId: 'require-fs' }), { code: 'AUTOMATION_JS_RECIPE_DENIED' });
});

test('pre-cancelled and in-flight JavaScript/conditional executions preserve cancellation', async (t) => {
  const state = await setup(t);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(() => handlers['automation.javascript']({ ...state.context, signal: pre.signal, recipeId: 'inspect-document-v1' }), { code: 'AUTOMATION_JS_CANCELLED' });

  const workflow = { workflowId: 'workflow_cancel', steps: [{
    stepId: 'step_1', condition: { field: 'document.pageCount', operator: 'gte', value: 1 },
    trueBranch: { operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }, repeat: 1 },
    falseBranch: { operation: null, repeat: 1 },
  }] };
  const controller = new AbortController();
  state.authority.pause('conditional.execute');
  const pending = assert.rejects(
    () => handlers['automation.conditional-workflows']({ ...state.context, signal: controller.signal, workflow }),
    { code: 'AUTOMATION_CONDITIONAL_CANCELLED' },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  state.authority.release();
  await pending;
  await assert.rejects(() => handlers['automation.conditional-workflows']({ ...state.context, workflow, signal: pre.signal }), { code: 'AUTOMATION_CONDITIONAL_CANCELLED' });
});

test('schedules validate tick/service prerequisites before creation and roll back post-create failure', async (t) => {
  const state = await setup(t);
  const list = () => state.scheduledJobs.list({ principal: PRINCIPAL, grant: GRANT });
  await assert.rejects(() => handlers['automation.scheduled-jobs']({ ...state.context, scheduleId: 'bad-tick', firstAt: 1_000, tickAt: -1 }), { code: 'INVALID_AUTOMATION_INPUT' });
  assert.equal((await list()).length, 0);
  const hiddenTick = new Proxy(state.scheduledJobs, { get(target, property, receiver) {
    if (property === 'tick') return undefined;
    return Reflect.get(target, property, receiver);
  } });
  await assert.rejects(() => handlers['automation.scheduled-jobs']({ ...state.context, automation: { ...state.automation, scheduledJobs: hiddenTick }, scheduleId: 'no-tick', firstAt: 1_000, tickAt: 1_000 }), { code: 'AUTOMATION_SERVICE_REQUIRED' });
  assert.equal((await list()).length, 0);

  const originalStart = state.scheduledJobs.start;
  state.scheduledJobs.start = async () => { throw new Error('post-create start failure'); };
  await assert.rejects(() => handlers['automation.scheduled-jobs']({ ...state.context, scheduleId: 'rollback-me', firstAt: 1_000 }), { message: 'post-create start failure' });
  state.scheduledJobs.start = originalStart;
  assert.equal((await list()).length, 0);
});

test('schedule create-only mode preserves the real record without post-create work', async (t) => {
  const state = await setup(t);
  const outcome = await handlers['automation.scheduled-jobs']({ ...state.context, scheduleId: 'create-only', firstAt: 1_000, start: false });
  assert.equal(outcome.schedule.scheduleId, 'create-only');
  assert.equal((await state.scheduledJobs.list({ principal: PRINCIPAL, grant: GRANT })).length, 1);
});

test('queue retry and reports use genuine API jobs and separate every lifecycle status', async (t) => {
  const state = await setup(t);
  const first = await handlers['automation.action-sequences'](sequenceRequest(state.context, { idempotencyKey: 'report-one' }));
  const second = await handlers['automation.action-sequences'](sequenceRequest(state.context, { idempotencyKey: 'report-two' }));
  const cancelled = await handlers['automation.job-queue-retry']({ ...state.context, jobId: second.job.id, action: 'cancel' });
  assert.equal(cancelled.job.status, 'cancelled');
  await assert.rejects(
    () => handlers['automation.job-queue-retry']({ ...state.context, jobId: first.job.id, action: 'retry' }),
    { code: 'INVALID_AUTOMATION_INPUT' },
  );
  const report = await handlers['automation.processing-reports']({ ...state.context, jobs: [{ jobId: first.job.id }, { jobId: second.job.id }] });
  assert.deepEqual({
    pending: report.report.pending, running: report.report.running,
    completed: report.report.completed, failed: report.report.failed,
    cancelled: report.report.cancelled,
  }, { pending: 1, running: 0, completed: 0, failed: 0, cancelled: 1 });
  assert.equal(Object.hasOwn(report, 'automaticRetry'), false);
  assert.equal(report.report.successRate, 0);
});

test('watch-folder temp roots and symlinks are cleaned after verification', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-watch-cleanup-'));
  const link = `${root}-link`;
  t.after(async () => {
    await rm(link, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'input.pdf'), createBlankPdf({ pages: 1 }), { mode: 0o600 });
  const first = await handlers['automation.watch-folders']({ directory: root });
  assert.equal(first.records.length, 1);
  await symlink(root, link);
  await assert.rejects(() => handlers['automation.watch-folders']({ directory: link }), { code: 'WATCH_DIRECTORY_INVALID' });
  await rm(link, { force: true });
  await rm(root, { recursive: true, force: true });
  await assert.rejects(() => handlers['automation.watch-folders']({ directory: root }), { code: 'WATCH_DIRECTORY_INVALID' });
});

test('automation professional handlers fail closed when services are omitted', async (t) => {
  const state = await setup(t);
  await assert.rejects(() => handlers['automation.action-sequences']({ ...state.context, automation: {} }), { code: 'AUTOMATION_SERVICE_REQUIRED' });
  await assert.rejects(() => handlers['automation.javascript']({ ...state.context, automation: {} }), { code: 'AUTOMATION_SERVICE_REQUIRED' });
  await assert.rejects(() => handlers['automation.processing-reports']({ ...state.context, automation: {}, jobs: [{ jobId: 'job_a' }] }), { code: 'AUTOMATION_SERVICE_REQUIRED' });
});

test('variables and presets remain the immutable shipped registry', async () => {
  const outcome = await handlers['automation.variables-presets']({ preset: AUTOMATION_INSPECT_PRESET });
  assert.equal(outcome.typed, true);
  assert.equal(Object.isFrozen(outcome.presets), true);
  await assert.rejects(() => handlers['automation.variables-presets']({ preset: 'caller-script' }), { code: 'INVALID_AUTOMATION_OPERATION' });
});

test('JavaScript service profile is passed unchanged across the professional boundary', async (t) => {
  const state = await setup(t);
  const execution = await handlers['automation.javascript']({ ...state.context, recipeId: 'inspect-document-v1' });
  assert.equal(execution.execution.recipe.id, 'inspect-document-v1');
  assert.equal(AUTOMATION_JS_PROFILE, 'local-automation-declarative-recipes-v1');
});
