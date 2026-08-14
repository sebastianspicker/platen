import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runAutomationCommand } from '../scripts/cli/commands/automation.mjs';
import { AutomationApiService } from '../scripts/host/automation/automation-api-service.mjs';
import { AutomationOperationRegistry } from '../scripts/host/automation/automation-operation-registry.mjs';
import * as cliRuntime from '../scripts/cli/runtime.mjs';
import { makeTextPdf } from './pdf-fixture.js';
import { outputCapture } from './support/automation-execution-fixture.js';

const grant = Object.freeze({ grantId: 'grant_local_1', principal: 'alice' });
const source = Object.freeze({ id: 'source_1', sha256: 'a'.repeat(64) });

test('watch-folder CLI discovers only stable local PDFs without staging them', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'automation-watch-entrypoint-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'inbox'); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'stable.pdf'), makeTextPdf('STABLE'));
  await writeFile(join(directory, 'ignored.txt'), 'not a PDF');
  const capture = outputCapture();
  await runAutomationCommand({ automation: {}, store: {} }, {
    command: 'automation-watch-discover', input: directory, automationRoot: root, output: null,
  }, capture.stream, cliRuntime);
  const result = capture.value();
  assert.equal(result.discoveryOnly, true); assert.equal(result.stableOnly, true); assert.equal(result.localOnly, true);
  assert.equal(result.stableCandidates.length, 1); assert.equal(result.stableCandidates[0].name, 'stable.pdf');
  assert.equal(JSON.stringify(result).includes('ignored.txt'), false);
});

function scheduleApplication() {
  const schedules = new Map(); const jobs = new Map(); let starts = 0;
  const service = {
    async start() { starts += 1; },
    async create(request) {
      const value = Object.freeze({ schemaVersion: 1, scheduleId: request.scheduleId, principal: request.principal, source: request.source, operation: request.operation, firstAt: request.firstAt, intervalMs: request.intervalMs, status: 'active', runs: Object.freeze([]) });
      schedules.set(request.scheduleId, value); return value;
    },
    async list(request) { return [...schedules.values()].filter((entry) => entry.principal === request.principal); },
    async tick(now) {
      const values = [];
      for (const [id, entry] of schedules) {
        const job = Object.freeze({ id: `job_${id}`, type: entry.operation.id, status: 'pending', receipt: null }); jobs.set(job.id, job);
        const updated = Object.freeze({ ...entry, runs: Object.freeze([{ occurrence: now, scheduledAt: now, status: 'submitted', jobId: job.id }]) }); schedules.set(id, updated); values.push(updated);
      }
      return values;
    },
    async cancel(request) { const value = Object.freeze({ ...schedules.get(request.scheduleId), status: 'cancelled' }); schedules.set(request.scheduleId, value); return value; },
  };
  return { starts: () => starts, application: { automation: { scheduledJobs: service, queue: { async get(id) { return jobs.get(id); } } }, store: {} } };
}

async function run(application, command) {
  const capture = outputCapture(); await runAutomationCommand(application, { automationRoot: 'private', output: null, ...command }, capture.stream, cliRuntime); return capture.value();
}

test('schedule and processing-report CLI commands execute through durable application services', async () => {
  const state = scheduleApplication();
  const created = await run(state.application, { command: 'automation-schedule-create', scheduleId: 'schedule_1', principal: grant.principal, grantId: grant.grantId, sourceId: source.id, sha256: source.sha256, operationId: 'automation_inspect_v1', operationKind: 'operation', pages: null, firstAt: 1_000, intervalMs: null });
  assert.equal(created.schedule.scheduleId, 'schedule_1'); assert.equal(created.localOnly, true);
  const listed = await run(state.application, { command: 'automation-schedule-list', principal: grant.principal, grantId: grant.grantId });
  assert.equal(listed.schedules.length, 1);
  const ticked = await run(state.application, { command: 'automation-schedule-tick', principal: grant.principal, grantId: grant.grantId, now: 1_000 });
  assert.equal(ticked.schedules[0].runs[0].jobId, 'job_schedule_1');
  const report = await run(state.application, { command: 'automation-job-status', principal: grant.principal, grantId: grant.grantId });
  assert.equal(report.count, 1); assert.deepEqual(report.counts, { pending: 1 }); assert.equal(report.jobs[0].job.id, 'job_schedule_1');
  const cancelled = await run(state.application, { command: 'automation-schedule-cancel', scheduleId: 'schedule_1', principal: grant.principal, grantId: grant.grantId });
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.schedule.status, 'cancelled'); assert.equal(state.starts(), 5);
});

test('processing-report CLI reads exact API-owned jobs with cancellation and strict evidence', async () => {
  const calls = []; const application = { store: {}, automation: { api: { async status(request) {
    calls.push(request); return { id: request.jobId, type: 'automation_inspect_v1', status: request.jobId === 'job_1' ? 'completed' : 'failed', attempts: 1, maxAttempts: 3, createdAt: 1, updatedAt: 2, retry: null, receipt: null };
  } } } };
  const report = await run(application, { command: 'automation-processing-report', principal: grant.principal, grantId: grant.grantId, jobIds: ['job_1', 'job_2'] });
  assert.equal(report.report.total, 2); assert.equal(report.report.completed, 1); assert.equal(report.report.failed, 1); assert.equal(report.report.successRate, 0.5); assert.match(report.reportSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(calls.map((call) => call.jobId), ['job_1', 'job_2']); assert.equal(calls.every((call) => call.grant.principal === grant.principal), true);
  application.automation.api.status = async (request) => ({ id: `${request.jobId}-forged`, status: 'completed', attempts: 1, maxAttempts: 3, createdAt: 1, updatedAt: 2 });
  await assert.rejects(run(application, { command: 'automation-processing-report', principal: grant.principal, grantId: grant.grantId, jobIds: ['job_1'] }), { code: 'AUTOMATION_RESULT_INVALID' });
  for (const invalid of [
    { id: 'job_1', type: 'unknown', status: 'completed', attempts: 1, maxAttempts: 3, createdAt: 1, updatedAt: 2, retry: null, receipt: null },
    { id: 'job_1', type: 'automation_inspect_v1', status: 'running', attempts: 4, maxAttempts: 3, createdAt: 1, updatedAt: 2, retry: { classification: 'later', notBefore: 3 }, receipt: null },
    new Proxy({ id: 'job_1' }, {}),
  ]) {
    application.automation.api.status = async () => invalid;
    await assert.rejects(run(application, { command: 'automation-processing-report', principal: grant.principal, grantId: grant.grantId, jobIds: ['job_1'] }), { code: 'AUTOMATION_RESULT_INVALID' });
  }
});

test('processing-report CLI uses real API ownership and denies another principal', async () => {
  let job = null;
  const queue = {
    async enqueue(request) {
      job = { id: 'job_real', type: request.type, payload: request.payload,
        status: 'pending', attempts: 0, maxAttempts: 3, createdAt: 1, updatedAt: 1,
        lease: null, retry: null, receipt: null,
        transaction: { source: request.transaction, output: null } };
      return { idempotent: false, job };
    },
    async admission() { return { accepting: true, existing: null }; },
    async get(id) { assert.equal(id, job.id); return job; },
    async cancel() { return job; },
  };
  const api = new AutomationApiService({
    queue, registry: new AutomationOperationRegistry(), worker: null,
    sources: {
      async openVerified(id, sha256) { return { id, sha256, size: 10, stream: Readable.from([Buffer.from('source')]) }; },
      async commit() {},
      async getOutputMetadata() { throw new Error('unused'); },
    },
    authority: { async authorize(value) { if (value.grantId !== grant.grantId || value.principal !== grant.principal) return false; } },
  });
  const submitted = await api.submit({ principal: grant.principal, grant, source, operation: { kind: 'operation', id: 'automation_inspect_v1', pages: null }, idempotencyKey: 'report-proof' });
  assert.equal(submitted.job.id, job.id);
  const report = await run({ store: {}, automation: { api } }, { command: 'automation-processing-report', principal: grant.principal, grantId: grant.grantId, jobIds: [job.id] });
  assert.equal(report.report.pending, 1);
  await assert.rejects(run({ store: {}, automation: { api } }, { command: 'automation-processing-report', principal: 'mallory', grantId: grant.grantId, jobIds: [job.id] }), { code: 'AUTOMATION_API_CAPABILITY_DENIED' });
});
