import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBlankPdf } from '../pdf-factory.mjs';
import { snapshotPdfDirectory } from '../watch-folder.mjs';
import { result, fail, requireString } from './support.mjs';

function digestSeed(type, seed) {
  return createHash('sha256').update(`${type}|${String(seed ?? randomUUID())}`).digest('hex').slice(0, 32);
}

const API_OPERATIONS = Object.freeze(new Set([
  'compose', 'split', 'compress', 'export', 'preflight', 'print', 'ocr', 'merge',
]));

const SEQUENCE_OPS = Object.freeze(new Set([
  'open', 'compress', 'save', 'export', 'merge', 'split', 'watermark', 'encrypt', 'ocr',
]));

const PREFLIGHT_PROFILES = Object.freeze(new Set([
  'print-review', 'web-optimize', 'pdfa-2b', 'accessibility-lite', 'archive',
]));

/** Validate classic 5-field cron: min hour dom mon dow (ranges / steps / lists / *). */
function parseCronFive(cron) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) fail('INVALID_CRON', 'cron must have exactly 5 fields (min hour dom mon dow).', 400);
  const bounds = [
    [0, 59], [0, 23], [1, 31], [1, 12], [0, 7],
  ];
  const parsed = fields.map((field, index) => {
    const [lo, hi] = bounds[index];
    if (field === '*') return { raw: field, any: true, lo, hi };
    const parts = field.split(',');
    const values = [];
    for (const part of parts) {
      const stepMatch = /^(\*|\d+)(?:-(\d+))?\/(\d+)$/.exec(part);
      const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
      const numMatch = /^(\d+)$/.exec(part);
      if (stepMatch) {
        const start = stepMatch[1] === '*' ? lo : Number(stepMatch[1]);
        const end = stepMatch[2] != null ? Number(stepMatch[2]) : hi;
        const step = Number(stepMatch[3]);
        if (step < 1 || start < lo || end > hi || start > end) {
          fail('INVALID_CRON', `cron field ${index + 1} out of range.`, 400);
        }
        for (let v = start; v <= end; v += step) values.push(v);
      } else if (rangeMatch) {
        const a = Number(rangeMatch[1]);
        const b = Number(rangeMatch[2]);
        if (a < lo || b > hi || a > b) fail('INVALID_CRON', `cron field ${index + 1} range invalid.`, 400);
        for (let v = a; v <= b; v += 1) values.push(v);
      } else if (numMatch) {
        const n = Number(numMatch[1]);
        if (n < lo || n > hi) fail('INVALID_CRON', `cron field ${index + 1} value ${n} out of [${lo},${hi}].`, 400);
        values.push(n);
      } else {
        fail('INVALID_CRON', `cron field ${index + 1} token invalid: ${part}`, 400);
      }
    }
    return { raw: field, any: false, values: Object.freeze([...new Set(values)].sort((a, b) => a - b)), lo, hi };
  });
  return Object.freeze(parsed);
}

/** Evaluate simple pageCount comparisons: pageCount OP number. */
function evalPageCountCondition(condition, pageCount) {
  const match = /^\s*pageCount\s*(==|!=|<=|>=|<|>)\s*(\d+)\s*$/.exec(condition);
  if (!match) {
    if (/pageCount/.test(condition)) fail('INVALID_CONDITION', 'condition must be "pageCount OP number".', 400);
    return { matched: false, reason: 'no-pageCount-predicate' };
  }
  const op = match[1];
  const rhs = Number(match[2]);
  let matched = false;
  switch (op) {
    case '>': matched = pageCount > rhs; break;
    case '>=': matched = pageCount >= rhs; break;
    case '<': matched = pageCount < rhs; break;
    case '<=': matched = pageCount <= rhs; break;
    case '==': matched = pageCount === rhs; break;
    case '!=': matched = pageCount !== rhs; break;
    default: fail('INVALID_CONDITION', `unsupported op ${op}`, 400);
  }
  return { matched, op, rhs };
}

export function automationCliBatch(ctx = {}) {
  if (ctx.network === true || ctx.webhookUrl) {
    fail('NETWORK_FORBIDDEN', 'Network side effects require adapter injection.', 403);
  }
  const inputs = Array.isArray(ctx.inputs) ? ctx.inputs.map(String).slice(0, 50) : ['a.pdf', 'b.pdf'];
  if (inputs.length < 1) fail('INVALID_BATCH', 'inputs required', 400);
  const completedAt = new Date(0).toISOString();
  const outputs = inputs.map((name, index) => {
    const payload = `cli-batch|${name}|${index}|${ctx.seed ?? ''}`;
    return Object.freeze({
      name: name.replace(/\.pdf$/i, '') + '.out.pdf',
      input: name,
      sha256: createHash('sha256').update(payload).digest('hex'),
      status: 'completed',
    });
  });
  const job = Object.freeze({
    id: digestSeed('cli-batch', ctx.seed ?? inputs.join(',')),
    type: 'cli-batch',
    status: 'completed-local',
    inputs: Object.freeze([...inputs]),
    outputs: Object.freeze(outputs),
    completedAt,
    outputCount: outputs.length,
  });
  return result('automation.cli-batch', {
    method: 'local-automation-cli-batch-run',
    job,
    jobSha256: createHash('sha256').update(JSON.stringify(job)).digest('hex'),
  });
}

export function automationApi(ctx = {}) {
  if (ctx.network === true || ctx.remoteUrl) {
    fail('NETWORK_FORBIDDEN', 'Network side effects require adapter injection.', 403);
  }
  const operation = requireString(ctx.operation ?? 'compose', 'operation', { min: 1, max: 80 }).toLowerCase();
  if (!API_OPERATIONS.has(operation)) {
    fail('INVALID_OPERATION', `operation must be one of: ${[...API_OPERATIONS].join(', ')}`, 400);
  }
  const bodyBytes = Buffer.byteLength(JSON.stringify(ctx.body ?? {}), 'utf8');
  if (bodyBytes > 64 * 1024) fail('PAYLOAD_TOO_LARGE', 'request body exceeds 64KiB', 413);
  const request = Object.freeze({
    id: digestSeed('api', operation + String(ctx.seed ?? '')),
    operation,
    accepted: true,
    localOnly: true,
    bodyBytes,
    acceptedAt: new Date(0).toISOString(),
  });
  return result('automation.api', {
    method: 'local-automation-api-accept',
    request,
    requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
  });
}

export async function automationWatchFolders(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Network side effects require adapter injection.', 403);
  const dir = ctx.directory ?? join(tmpdir(), `pdf-watch-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'sample.pdf'), createBlankPdf({ pages: 1 }), { mode: 0o600 });
  const records = await snapshotPdfDirectory(dir, { maxEntries: 64, maxPdfFiles: 32 });
  return result('automation.watch-folders', {
    method: 'local-watch-folder-snapshot',
    directory: dir,
    records,
    count: records.length,
  });
}

export function automationActionSequences(ctx = {}) {
  const raw = Array.isArray(ctx.steps) ? ctx.steps.slice(0, 50) : [
    { op: 'open', args: {} },
    { op: 'compress', args: {} },
    { op: 'save', args: {} },
  ];
  if (raw.length < 1) fail('INVALID_SEQUENCE', 'steps required', 400);
  const steps = [];
  for (let i = 0; i < raw.length; i += 1) {
    const op = String(raw[i]?.op ?? raw[i] ?? '').toLowerCase();
    if (!SEQUENCE_OPS.has(op)) fail('INVALID_SEQUENCE_OP', `unknown step op: ${op}`, 400);
    steps.push(Object.freeze({ index: i, op, status: 'planned', args: Object.freeze({ ...(raw[i]?.args ?? {}) }) }));
  }
  const allPlanned = steps.every((s) => s.status === 'planned');
  const sequence = Object.freeze({
    id: digestSeed('sequence', ctx.seed ?? steps.map((s) => s.op).join('>')),
    steps: Object.freeze(steps),
    status: allPlanned ? 'validated' : 'planned',
    stepCount: steps.length,
  });
  return result('automation.action-sequences', {
    method: 'local-automation-action-sequence',
    sequence,
    stepCount: sequence.stepCount,
  });
}

export function automationJavascript(ctx = {}) {
  if (ctx.execute === true && ctx.unsafe === true) {
    fail('JS_UNSAFE_FORBIDDEN', 'Unsafe JS execution is disabled.', 403);
  }
  const script = requireString(ctx.script ?? '/* local automation script */', 'script', { min: 1, max: 10_000 });
  if (/require\s*\(|import\s+|process\.|child_process|fs\.|vm\.|eval\s*\(/.test(script)) {
    fail('JS_HOST_ESCAPE', 'Script may not access host modules.', 400);
  }
  const scriptSha256 = createHash('sha256').update(script).digest('hex');
  return result('automation.javascript', {
    method: 'local-automation-js-validate',
    scriptSha256,
    validated: true,
    executed: false,
    bytes: Buffer.byteLength(script, 'utf8'),
  });
}

export function automationScheduledJobs(ctx = {}) {
  const cron = requireString(ctx.cron ?? '0 * * * *', 'cron', { min: 9, max: 80 });
  const fields = parseCronFive(cron);
  const job = Object.freeze({
    id: digestSeed('scheduled', cron),
    cron,
    fields: fields.map((f) => f.raw),
    nextRunHint: 'local-schedule-table',
    enabled: ctx.enabled !== false,
    fieldCount: 5,
  });
  return result('automation.scheduled-jobs', {
    method: 'local-automation-schedule-entry',
    job,
  });
}

export function automationConditionalWorkflows(ctx = {}) {
  const condition = requireString(ctx.condition ?? 'pageCount > 1', 'condition', { min: 1, max: 200 });
  if (!Number.isSafeInteger(ctx.pageCount) && ctx.pageCount != null) {
    fail('INVALID_PAGE_COUNT', 'pageCount must be a safe integer when provided.', 400);
  }
  const pageCount = Number.isSafeInteger(ctx.pageCount) ? ctx.pageCount : 2;
  if (pageCount < 0 || pageCount > 100_000) fail('INVALID_PAGE_COUNT', 'pageCount out of bounds.', 400);
  const evaluation = evalPageCountCondition(condition, pageCount);
  return result('automation.conditional-workflows', {
    method: 'local-automation-conditional-eval',
    condition,
    pageCount,
    matched: evaluation.matched,
    branch: evaluation.matched ? 'then' : 'else',
    evaluation: Object.freeze(evaluation),
  });
}

export function automationVariablesPresets(ctx = {}) {
  const raw = Array.isArray(ctx.presets) ? ctx.presets : [
    { name: 'compress-web', vars: { dpi: 150 } },
    { name: 'archive', vars: { profile: 'pdfa-2b' } },
  ];
  if (raw.length < 1) fail('INVALID_PRESETS', 'presets required', 400);
  const table = [];
  const names = new Set();
  for (const entry of raw.slice(0, 50)) {
    const name = requireString(String(entry?.name ?? ''), 'preset.name', { min: 1, max: 80 });
    if (names.has(name)) fail('DUPLICATE_PRESET', `preset name collision: ${name}`, 400);
    names.add(name);
    const vars = entry?.vars && typeof entry.vars === 'object' && !Array.isArray(entry.vars)
      ? Object.freeze({ ...entry.vars })
      : Object.freeze({});
    table.push(Object.freeze({
      name,
      vars,
      presetId: createHash('sha256').update(`preset|${name}|${JSON.stringify(vars)}`).digest('hex').slice(0, 16),
    }));
  }
  return result('automation.variables-presets', {
    method: 'local-automation-presets-table',
    presets: Object.freeze(table),
    count: table.length,
  });
}

export function automationJobQueueRetry(ctx = {}) {
  const attempts = Number.isSafeInteger(ctx.attempts) ? ctx.attempts : 1;
  const maxAttempts = Number.isSafeInteger(ctx.maxAttempts) ? ctx.maxAttempts : 3;
  const baseMs = Number.isSafeInteger(ctx.baseMs) ? ctx.baseMs : 1000;
  if (attempts < 0 || attempts > 100) fail('INVALID_RETRY', 'attempts out of range', 400);
  if (maxAttempts < 1 || maxAttempts > 20) fail('INVALID_RETRY', 'maxAttempts', 400);
  if (baseMs < 1 || baseMs > 60_000) fail('INVALID_RETRY', 'baseMs', 400);
  const exponent = Math.max(0, attempts - 1);
  const backoffMs = Math.min(60_000, baseMs * (2 ** exponent));
  const status = attempts >= maxAttempts ? 'dead-letter-local' : 'queued-retry-local';
  return result('automation.job-queue-retry', {
    method: 'local-automation-queue-retry-policy',
    attempts,
    maxAttempts,
    status,
    backoffMs,
    baseMs,
    exponent,
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

export function automationProcessingReports(ctx = {}) {
  const jobs = Array.isArray(ctx.jobs) ? ctx.jobs.slice(0, 500) : [
    { id: 'j1', status: 'ok' },
    { id: 'j2', status: 'ok' },
  ];
  let ok = 0;
  let failed = 0;
  for (const job of jobs) {
    const status = String(job?.status ?? 'unknown');
    if (status === 'ok' || status === 'completed' || status === 'success') ok += 1;
    else failed += 1;
  }
  const report = Object.freeze({
    kind: 'automation-processing-report',
    total: jobs.length,
    ok,
    failed,
    successRate: jobs.length === 0 ? 0 : ok / jobs.length,
  });
  return result('automation.processing-reports', {
    method: 'local-automation-processing-report',
    report,
    reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
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

export const handlers = Object.freeze({
  async 'automation.cli-batch'(ctx = {}) { return automationCliBatch(ctx); },
  async 'automation.api'(ctx = {}) { return automationApi(ctx); },
  async 'automation.watch-folders'(ctx = {}) { return automationWatchFolders(ctx); },
  async 'automation.action-sequences'(ctx = {}) { return automationActionSequences(ctx); },
  async 'automation.javascript'(ctx = {}) { return automationJavascript(ctx); },
  async 'automation.scheduled-jobs'(ctx = {}) { return automationScheduledJobs(ctx); },
  async 'automation.conditional-workflows'(ctx = {}) { return automationConditionalWorkflows(ctx); },
  async 'automation.variables-presets'(ctx = {}) { return automationVariablesPresets(ctx); },
  async 'automation.job-queue-retry'(ctx = {}) { return automationJobQueueRetry(ctx); },
  async 'automation.webhooks'(ctx = {}) { return automationWebhooks(ctx); },
  async 'automation.processing-reports'(ctx = {}) { return automationProcessingReports(ctx); },
  async 'automation.preflight-server'(ctx = {}) { return automationPreflightServer(ctx); },
  async 'automation.batch-print'(ctx = {}) { return automationBatchPrint(ctx); },
});
