import { HostError } from '../host-error.mjs';
import { types as nodeTypes } from 'node:util';
import {
  AUTOMATION_SCHEDULE_MAX_CATCH_UP_MS,
  AUTOMATION_SCHEDULE_MAX_SCHEDULES,
  AUTOMATION_SCHEDULE_MAX_RUNS,
  normalizeAutomationScheduleCreateRequest,
  normalizeAutomationScheduleListRequest,
  normalizeAutomationScheduleJobRequest,
  publicAutomationSchedule,
  scheduleFail,
  scheduleOccurrenceKey,
} from './automation-scheduled-jobs-contract.mjs';
import {
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_INSPECT_PRESET,
  AUTOMATION_OCR_PRESET,
  AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_PRESET,
  AUTOMATION_OUTPUT_INTENT_TYPE,
} from './automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_TYPE } from './automation-sequence-contract.mjs';

function checkedClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) scheduleFail('AUTOMATION_SCHEDULE_CLOCK_INVALID', 'Schedule clock returned an invalid UTC epoch.', 500);
  return value;
}

function mapAuthorityError(error) {
  if (error instanceof HostError && error.code === 'AUTOMATION_SCHEDULE_CAPABILITY_DENIED') throw error;
  throw new HostError('AUTOMATION_SCHEDULE_CAPABILITY_DENIED', 'Schedule capability grant does not authorize this action.', 403, { cause: error });
}

function expectedType(operation) {
  if (operation.kind === 'sequence') return AUTOMATION_SEQUENCE_TYPE;
  if (operation.kind === 'preset') {
    if (operation.id === AUTOMATION_INSPECT_PRESET) return AUTOMATION_INSPECT_TYPE;
    if (operation.id === AUTOMATION_OCR_PRESET) return AUTOMATION_OCR_TYPE;
    if (operation.id === AUTOMATION_OUTPUT_INTENT_PRESET) return AUTOMATION_OUTPUT_INTENT_TYPE;
  }
  return operation.id;
}

function checkedQueued(value, operation) {
  const descriptors = value && typeof value === 'object' && !Array.isArray(value) && !nodeTypes.isProxy(value)
    ? Object.getOwnPropertyDescriptors(value) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 3 || !Object.hasOwn(value, 'schemaVersion') || !Object.hasOwn(value, 'idempotent') || !Object.hasOwn(value, 'job')
    || !descriptors || Reflect.ownKeys(value).some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || descriptors.schemaVersion.value !== 1 || typeof descriptors.idempotent.value !== 'boolean') {
    throw new HostError('AUTOMATION_SCHEDULE_QUEUE_RESULT_INVALID', 'Automation queue response is invalid.', 502);
  }
  const job = descriptors.job.value;
  const jobDescriptors = job && typeof job === 'object' && !Array.isArray(job) && !nodeTypes.isProxy(job)
    ? Object.getOwnPropertyDescriptors(job) : null;
  if (!job || typeof job !== 'object' || Array.isArray(job) || nodeTypes.isProxy(job) || Object.getPrototypeOf(job) !== Object.prototype
    || !jobDescriptors || !Object.hasOwn(jobDescriptors, 'id') || !Object.hasOwn(jobDescriptors, 'type') || !Object.hasOwn(jobDescriptors, 'status')
    || Reflect.ownKeys(job).some((key) => !Object.hasOwn(jobDescriptors, key) || !Object.hasOwn(jobDescriptors[key], 'value') || jobDescriptors[key].enumerable !== true)
    || typeof jobDescriptors.id.value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(jobDescriptors.id.value)
    || jobDescriptors.type.value !== expectedType(operation)
    || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(jobDescriptors.status.value)) {
    throw new HostError('AUTOMATION_SCHEDULE_QUEUE_RESULT_INVALID', 'Automation queue job identity is invalid.', 502);
  }
  return Object.freeze({ id: jobDescriptors.id.value, idempotent: descriptors.idempotent.value });
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_.-]{1,64}$/u.test(error.code)
    ? error.code : 'AUTOMATION_SCHEDULE_EXECUTION_FAILED';
}

export class AutomationScheduledJobsService {
  #store; #api; #authority; #clock; #started = false; #admission = Promise.resolve();

  constructor({ store, api, authority, clock = () => Date.now() } = {}) {
    if (!store || typeof store.initialize !== 'function' || typeof store.read !== 'function' || typeof store.mutate !== 'function' || typeof store.close !== 'function'
      || typeof api?.submit !== 'function' || typeof authority?.authorize !== 'function' || typeof clock !== 'function') {
      throw new TypeError('AutomationScheduledJobsService requires a schedule store, Automation API, and capability authority.');
    }
    this.#store = store;
    this.#api = api;
    this.#authority = authority;
    this.#clock = clock;
  }

  async #authorize(request, action, schedule = null) {
    const source = request.source ?? schedule?.source ?? null;
    const operation = request.operation ?? schedule?.operation ?? null;
    const safeSource = source && Object.freeze({ id: source.id, sha256: source.sha256 });
    const safeOperation = operation && Object.freeze({ id: operation.id, kind: operation.kind, pages: operation.pages === null ? null : Object.freeze([...operation.pages]) });
    try {
      const result = await this.#authority.authorize(request.grant, Object.freeze({
        principal: request.principal,
        capability: 'automation.schedule',
        action: `schedule.${action}`,
        scheduleId: request.scheduleId ?? schedule?.scheduleId ?? null,
        source: safeSource,
        operation: safeOperation,
      }));
      if (result === false) throw new HostError('AUTOMATION_SCHEDULE_CAPABILITY_DENIED', 'denied', 403);
    } catch (error) { mapAuthorityError(error); }
  }

  async create(value) {
    const request = normalizeAutomationScheduleCreateRequest(value, checkedClock(this.#clock));
    await this.#authorize(request, 'create');
    const now = checkedClock(this.#clock);
    return this.#store.mutate((state) => {
      if (state.schedules.some((item) => item.scheduleId === request.scheduleId)) {
        scheduleFail('AUTOMATION_SCHEDULE_EXISTS', 'Schedule ID already exists.', 409);
      }
      if (state.schedules.length >= AUTOMATION_SCHEDULE_MAX_SCHEDULES) scheduleFail('AUTOMATION_SCHEDULE_LIMIT', 'Schedule limit has been reached.', 429);
      const record = {
        schemaVersion: 1,
        scheduleId: request.scheduleId,
        principal: request.principal,
        grant: request.grant,
        source: request.source,
        operation: request.operation,
        firstAt: request.firstAt,
        intervalMs: request.intervalMs,
        nextAt: request.firstAt,
        status: 'enabled',
        runCount: 0,
        runs: [],
        createdAt: now,
        updatedAt: now,
      };
      state.schedules.push(record);
      return publicAutomationSchedule(record);
    });
  }

  createSchedule(value) { return this.create(value); }

  async list(value) {
    const request = normalizeAutomationScheduleListRequest(value);
    const state = await this.#store.read();
    const owned = state.schedules.filter((record) => record.principal === request.principal);
    await this.#authorize(request, 'list');
    for (const record of owned) await this.#authorize(request, 'list', record);
    return Object.freeze(owned.map((record) => publicAutomationSchedule(record)));
  }

  listSchedules(value) { return this.list(value); }

  async get(value) {
    const request = normalizeAutomationScheduleJobRequest(value, 'get');
    await this.#authorize(request, 'get');
    const state = await this.#store.read();
    const record = state.schedules.find((item) => item.scheduleId === request.scheduleId && item.principal === request.principal);
    if (!record) scheduleFail('AUTOMATION_SCHEDULE_NOT_FOUND', 'Schedule was not found.', 404);
    await this.#authorize(request, 'get', record);
    return publicAutomationSchedule(record);
  }

  getSchedule(value) { return this.get(value); }

  async #change(value, action, status) {
    const request = normalizeAutomationScheduleJobRequest(value, action);
    const run = this.#admission.then(() => this.#store.mutate((state) => {
      const record = state.schedules.find((item) => item.scheduleId === request.scheduleId && item.principal === request.principal);
      if (!record) scheduleFail('AUTOMATION_SCHEDULE_NOT_FOUND', 'Schedule was not found.', 404);
      return this.#authorize(request, action, record).then(() => {
        if (record.status === 'cancelled') scheduleFail('AUTOMATION_SCHEDULE_CANCELLED', 'Schedule has been cancelled.', 409);
        if (record.status === 'completed') scheduleFail('AUTOMATION_SCHEDULE_TRANSITION_INVALID', 'Schedule cannot be changed in its current state.', 409);
        record.status = status;
        record.updatedAt = checkedClock(this.#clock);
        return publicAutomationSchedule(record);
      });
    }));
    this.#admission = run.catch(() => {});
    return run;
  }

  disable(value) { return this.#change(value, 'disable', 'disabled'); }
  enable(value) { return this.#change(value, 'enable', 'enabled'); }
  cancel(value) { return this.#change(value, 'cancel', 'cancelled'); }
  disableSchedule(value) { return this.disable(value); }
  enableSchedule(value) { return this.enable(value); }
  cancelSchedule(value) { return this.cancel(value); }

  async delete(value) {
    const request = normalizeAutomationScheduleJobRequest(value, 'delete');
    const run = this.#admission.then(() => this.#store.mutate((state) => {
      const index = state.schedules.findIndex((item) => item.scheduleId === request.scheduleId && item.principal === request.principal);
      if (index < 0) scheduleFail('AUTOMATION_SCHEDULE_NOT_FOUND', 'Schedule was not found.', 404);
      const record = state.schedules[index];
      return this.#authorize(request, 'delete', record).then(() => {
        state.schedules.splice(index, 1);
        return Object.freeze({ schemaVersion: 1, scheduleId: request.scheduleId, deleted: true });
      });
    }));
    this.#admission = run.catch(() => {});
    return run;
  }

  deleteSchedule(value) { return this.delete(value); }

  async start() {
    if (this.#started) return;
    await this.#store.read();
    this.#started = true;
  }

  async stop() { this.#started = false; await this.#admission; }

  async close() {
    await this.stop();
    await this.#store.close();
  }

  async tick(now = checkedClock(this.#clock)) {
    if (!this.#started) scheduleFail('AUTOMATION_SCHEDULE_NOT_STARTED', 'Schedule service must be started before ticking.', 409);
    if (!Number.isSafeInteger(now) || now < 0) scheduleFail('AUTOMATION_SCHEDULE_CLOCK_INVALID', 'Schedule tick time is invalid.', 400);
    const run = this.#admission.then(() => this.#tick(now));
    this.#admission = run.catch(() => {});
    return run;
  }

  async #tick(now) {
    const state = await this.#store.read();
    const due = state.schedules.filter((record) => record.status === 'enabled' && record.nextAt !== null && record.nextAt <= now);
    const results = [];
    for (const descriptor of due) {
      const prepared = await this.#store.mutate((current) => {
        const record = current.schedules.find((item) => item.scheduleId === descriptor.scheduleId);
        if (!record || record.status !== 'enabled' || record.nextAt === null || record.nextAt > now) return null;
        if (record.runCount >= AUTOMATION_SCHEDULE_MAX_RUNS) {
          record.status = 'completed'; record.nextAt = null; record.updatedAt = now; return null;
        }
        let scheduledAt = record.nextAt;
        if (record.intervalMs !== null && now - scheduledAt > AUTOMATION_SCHEDULE_MAX_CATCH_UP_MS) {
          const count = Math.floor((now - scheduledAt) / record.intervalMs);
          if (count > 0) {
            const advance = count * record.intervalMs;
            if (!Number.isSafeInteger(advance) || scheduledAt > Number.MAX_SAFE_INTEGER - advance) scheduleFail('AUTOMATION_SCHEDULE_CLOCK_INVALID', 'Schedule occurrence exceeds the safe UTC epoch range.', 500);
            scheduledAt += advance;
          }
        }
        const occurrence = scheduleOccurrenceKey(record.scheduleId, scheduledAt);
        const existing = record.runs.find((item) => item.occurrence === occurrence);
        if (existing?.status === 'queued') return null;
        if (existing) {
          existing.status = 'admitting'; existing.errorCode = null; existing.startedAt = now;
          return { scheduleId: record.scheduleId, scheduledAt, occurrence, request: record };
        }
        if (record.runs.length >= AUTOMATION_SCHEDULE_MAX_RUNS) scheduleFail('AUTOMATION_SCHEDULE_RUN_LIMIT', 'Schedule run limit has been reached.', 429);
        record.runs.push({ occurrence, scheduledAt, status: 'admitting', jobId: null, startedAt: now, finishedAt: null, errorCode: null });
        return { scheduleId: record.scheduleId, scheduledAt, occurrence, request: record };
      });
      if (!prepared) continue;
      const request = {
        principal: prepared.request.principal,
        grant: Object.freeze({ ...prepared.request.grant }),
        source: Object.freeze({ ...prepared.request.source }),
        operation: Object.freeze({ ...prepared.request.operation, pages: prepared.request.operation.pages === null ? null : Object.freeze([...prepared.request.operation.pages]) }),
        idempotencyKey: prepared.occurrence,
      };
      try {
        await this.#authorize(request, 'execute', prepared.request);
        const queued = checkedQueued(await this.#api.submit(request), prepared.request.operation);
        const updated = await this.#store.mutate((current) => {
          const record = current.schedules.find((item) => item.scheduleId === prepared.scheduleId);
          if (!record) return null;
          const item = record.runs.find((entry) => entry.occurrence === prepared.occurrence);
          if (!item) return null;
          item.status = 'queued'; item.jobId = queued.id; item.finishedAt = checkedClock(this.#clock); item.errorCode = null;
          record.runCount += 1;
          if (record.intervalMs === null) { record.nextAt = null; record.status = 'completed'; }
          else {
            const next = prepared.scheduledAt + record.intervalMs;
            if (!Number.isSafeInteger(next)) scheduleFail('AUTOMATION_SCHEDULE_CLOCK_INVALID', 'Schedule occurrence exceeds the safe UTC epoch range.', 500);
            record.nextAt = next;
          }
          record.updatedAt = checkedClock(this.#clock);
          return publicAutomationSchedule(record);
        });
        if (updated) results.push(updated);
      } catch (error) {
        await this.#store.mutate((current) => {
          const record = current.schedules.find((item) => item.scheduleId === prepared.scheduleId);
          const item = record?.runs.find((entry) => entry.occurrence === prepared.occurrence);
          if (item) { item.status = 'pending'; item.errorCode = safeErrorCode(error); item.finishedAt = checkedClock(this.#clock); }
          if (record) record.updatedAt = checkedClock(this.#clock);
        });
        const failed = await this.#store.read();
        const record = failed.schedules.find((item) => item.scheduleId === prepared.scheduleId);
        if (record) results.push(publicAutomationSchedule(record));
      }
    }
    return Object.freeze(results);
  }
}
