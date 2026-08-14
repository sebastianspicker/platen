import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, symlink, writeFile, link, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationScheduleStore } from '../scripts/host/automation/automation-scheduled-jobs-store.mjs';
import { AutomationScheduledJobsService } from '../scripts/host/automation/automation-scheduled-jobs-service.mjs';
import { AUTOMATION_INSPECT_TYPE } from '../scripts/host/automation/automation-operation-contract.mjs';

const source = { id: 'source_1', sha256: 'a'.repeat(64) };
const grant = { grantId: 'grant_local_1', principal: 'caller.one' };
const operation = { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null };

async function setup({ clock = () => 1_000_000, submit = null, authority = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-schedule-'));
  const store = await new AutomationScheduleStore({ root }).initialize();
  const calls = [];
  const api = { async submit(request) { calls.push(request); return submit ? submit(request, calls) : { schemaVersion: 1, idempotent: false, job: { id: `job_${calls.length}`, type: AUTOMATION_INSPECT_TYPE, status: 'pending' } }; } };
  const authCalls = [];
  const auth = authority ?? { async authorize(value, context) { authCalls.push({ value, context }); } };
  const service = new AutomationScheduledJobsService({ store, api, authority: auth, clock });
  return { root, store, service, calls, authCalls };
}

function createRequest(overrides = {}) {
  return { principal: grant.principal, grant, scheduleId: 'schedule_1', source, operation, firstAt: 1_000_000, intervalMs: null, ...overrides };
}

test('one-shot schedule admits exactly one deterministic occurrence and survives restart', async () => {
  const state = await setup();
  await state.service.create(createRequest());
  await state.service.start();
  const result = await state.service.tick(1_000_000);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].idempotencyKey, 'automation-schedule:schedule_1:1000000');
  assert.equal(result[0].status, 'completed');
  await state.service.close();
  const reopened = await new AutomationScheduleStore({ root: state.root }).initialize();
  const service = new AutomationScheduledJobsService({ store: reopened, api: { async submit() { throw new Error('must not replay'); } }, authority: { async authorize() {} }, clock: () => 2_000_000 });
  await service.start();
  assert.equal((await service.tick(2_000_000)).length, 0);
  await reopened.close();
});

test('fixed interval skips stale occurrences and advances only after queue admission', async () => {
  const state = await setup();
  await state.service.create(createRequest({ intervalMs: 60_000 }));
  await state.service.start();
  await state.service.tick(1_000_000 + 60_000 * 65);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].idempotencyKey, 'automation-schedule:schedule_1:4900000');
  const record = await state.service.get({ principal: grant.principal, grant, scheduleId: 'schedule_1' });
  assert.equal(record.nextAt, 4_960_000);
  await state.store.close();
});

test('queue failure leaves an admitting occurrence retryable without duplicate persisted runs', async () => {
  let failures = 1;
  const state = await setup({ submit: async (request) => { if (failures--) throw Object.assign(new Error('queue down'), { code: 'QUEUE_FULL' }); return { schemaVersion: 1, idempotent: true, job: { id: 'job_retry', type: AUTOMATION_INSPECT_TYPE, status: 'pending' } }; } });
  await state.service.create(createRequest());
  await state.service.start();
  const failed = await state.service.tick(1_000_000);
  assert.equal(failed.length, 1);
  let record = await state.service.get({ principal: grant.principal, grant, scheduleId: 'schedule_1' });
  assert.equal(record.runs.length, 1);
  assert.equal(record.runs[0].status, 'pending');
  await state.service.tick(1_000_000);
  record = await state.service.get({ principal: grant.principal, grant, scheduleId: 'schedule_1' });
  assert.equal(record.runs.length, 1);
  assert.equal(record.runs[0].jobId, 'job_retry');
  await state.store.close();
});

test('authority is checked at execution and forged grants are rejected before queue access', async () => {
  let denied = false;
  const state = await setup({ authority: { async authorize(value, context) { if (context.action === 'schedule.execute') { denied = true; throw new Error('no longer allowed'); } } } });
  await state.service.create(createRequest());
  await state.service.start();
  const deniedResult = await state.service.tick(1_000_000);
  assert.equal(deniedResult.length, 1);
  assert.equal(denied, true);
  await assert.rejects(state.service.create(createRequest({ grant: { grantId: 'grant_local_1', principal: 'other' } })), { code: 'AUTOMATION_SCHEDULE_GRANT_MISMATCH' });
  await state.store.close();
});

test('false and canonical authority denials stop execution without queue admission', async () => {
  for (const denial of ['false', 'error']) {
    const state = await setup({ authority: { async authorize(value, context) {
      if (context.action === 'schedule.execute') {
        if (denial === 'false') return false;
        throw Object.assign(new Error('denied'), { code: 'AUTOMATION_SCHEDULE_CAPABILITY_DENIED' });
      }
    } } });
    await state.service.create(createRequest());
    await state.service.start();
    const result = await state.service.tick(1_000_000);
    assert.equal(result.length, 1);
    assert.equal(state.calls.length, 0);
    await state.store.close();
  }
});

test('schedule requests reject accessors, proxies, and unsafe persistent state links', async () => {
  const state = await setup();
  const accessor = createRequest();
  Object.defineProperty(accessor, 'scheduleId', { enumerable: true, get() { throw new Error('trap'); } });
  await assert.rejects(state.service.create(accessor), { code: 'INVALID_AUTOMATION_SCHEDULE' });
  await assert.rejects(state.service.create(new Proxy(createRequest(), {})), { code: 'INVALID_AUTOMATION_SCHEDULE' });
  await state.store.close();
  const linkedRoot = await mkdtemp(join(tmpdir(), 'pdf-schedule-link-'));
  await symlink(state.root, join(linkedRoot, 'root-link'));
  await assert.rejects(new AutomationScheduleStore({ root: join(linkedRoot, 'root-link') }).initialize(), { code: 'AUTOMATION_SCHEDULE_STORAGE_UNSAFE' });
  const hardRoot = await mkdtemp(join(tmpdir(), 'pdf-schedule-hard-'));
  const sourceFile = join(hardRoot, 'source');
  await writeFile(sourceFile, 'x');
  await link(sourceFile, join(hardRoot, 'schedules.json'));
  await assert.rejects(new AutomationScheduleStore({ root: hardRoot }).initialize(), { code: 'AUTOMATION_SCHEDULE_STORAGE_UNSAFE' });
});

test('schedule actions are explicit and cancellation disables future admission', async () => {
  const state = await setup();
  await state.service.create(createRequest({ intervalMs: 60_000 }));
  await assert.rejects(state.service.tick(1_000_000), { code: 'AUTOMATION_SCHEDULE_NOT_STARTED' });
  await state.service.start();
  await state.service.disable({ principal: grant.principal, grant, scheduleId: 'schedule_1' });
  assert.equal((await state.service.tick(1_000_000)).length, 0);
  await state.service.cancel({ principal: grant.principal, grant, scheduleId: 'schedule_1' });
  await assert.rejects(state.service.enable({ principal: grant.principal, grant, scheduleId: 'schedule_1' }), { code: 'AUTOMATION_SCHEDULE_CANCELLED' });
  await state.service.delete({ principal: grant.principal, grant, scheduleId: 'schedule_1' });
  await assert.rejects(state.service.get({ principal: grant.principal, grant, scheduleId: 'schedule_1' }), { code: 'AUTOMATION_SCHEDULE_NOT_FOUND' });
  await state.store.close();
});

test('store ownership never removes another live owner and failed mutations roll back', async () => {
  const state = await setup();
  const second = new AutomationScheduleStore({ root: state.root });
  await assert.rejects(second.initialize(), { code: 'AUTOMATION_SCHEDULE_ALREADY_OPEN' });
  assert.equal((await state.store.read()).schedules.length, 0);
  await assert.rejects(state.store.mutate((candidate) => { candidate.schedules.push({}); throw new Error('abort'); }));
  assert.equal((await state.store.read()).schedules.length, 0);
  await state.store.close();
});

test('nested persisted corruption fails closed before exposing schedule records', async () => {
  const state = await setup();
  await state.service.create(createRequest());
  await state.store.close();
  const path = join(state.root, 'schedules.json');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  parsed.schedules[0].grant.extra = 'forged';
  await writeFile(path, JSON.stringify(parsed), { mode: 0o600 });
  await assert.rejects(new AutomationScheduleStore({ root: state.root }).initialize(), { code: 'AUTOMATION_SCHEDULE_STORAGE_CORRUPT' });
});

test('listing requires an owning grant and never exposes another principal', async () => {
  const state = await setup();
  await state.service.create(createRequest());
  const listed = await state.service.list({ principal: grant.principal, grant });
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0], 'grant'), false);
  assert.equal((await state.service.list({ principal: 'other', grant: { grantId: 'grant_other_1', principal: 'other' } })).length, 0);
  await state.store.close();
});

test('cancellation is serialized behind an in-flight tick admission', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = await setup({ submit: async () => { await gate; return { schemaVersion: 1, idempotent: false, job: { id: 'job_serial', type: AUTOMATION_INSPECT_TYPE, status: 'pending' } }; } });
  await state.service.create(createRequest({ intervalMs: 60_000 }));
  await state.service.start();
  const ticking = state.service.tick(1_000_000);
  await new Promise((resolve) => setImmediate(resolve));
  let cancelled = false;
  const cancelling = state.service.cancel({ principal: grant.principal, grant, scheduleId: 'schedule_1' }).then(() => { cancelled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, false);
  release();
  await ticking;
  await cancelling;
  assert.equal(cancelled, true);
  await state.service.close();
});
