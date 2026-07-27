import { normalizedRectangle } from './normalized-rectangle.js';

export const SOURCE_BOUND_REDACTION_PLAN_PROFILE = 'source-bound-redaction-plan-v1';
export const SOURCE_BOUND_REDACTION_APPLICATION_PROFILE = 'source-bound-redaction-application-v1';
export const SOURCE_BOUND_REDACTION_PLAN_REPORT_PROFILE = 'source-bound-redaction-plan-report-v1';
export const VERIFIED_RASTER_BURN_PROFILE = 'verified-raster-burn-v2';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function exactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function digest(value, label) {
  if (!SHA256.test(value ?? '')) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('expectedWorkspaceRevision must be a non-negative integer.');
  }
  return value;
}

function opaqueId(value, label) {
  if (!OPAQUE_ID.test(value ?? '')) throw new TypeError(`${label} is invalid.`);
  return value;
}

function pageNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TypeError('Redaction target pages must be integers from 1 through 10000.');
  }
  return value;
}

function planRegion(value) {
  if (!exactObject(value, ['x', 'y', 'width', 'height'])) {
    throw new TypeError('Redaction plan regions require exactly x, y, width, and height.');
  }
  return Object.freeze(normalizedRectangle(value, 'Redaction plan region'));
}

function normalizeTarget(target) {
  if (exactObject(target, ['page', 'fullPage']) && target.fullPage === true) {
    return Object.freeze({ page: pageNumber(target.page), fullPage: true });
  }
  if (exactObject(target, ['page', 'region'])) {
    return Object.freeze({
      page: pageNumber(target.page),
      region: planRegion(target.region),
    });
  }
  throw new TypeError('Each redaction plan target must be exactly one full-page or regional target.');
}

function uniqueTargets(targets) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 64) {
    throw new TypeError('A redaction plan requires one to 64 targets.');
  }
  const normalized = targets.map(normalizeTarget);
  const keys = normalized.map((target) => JSON.stringify(target));
  if (new Set(keys).size !== keys.length) throw new TypeError('Redaction plan targets must be unique.');
  for (const target of normalized) {
    if (target.fullPage && normalized.some((candidate) => candidate !== target && candidate.page === target.page)) {
      throw new TypeError('A full-page redaction target cannot overlap another target on the same page.');
    }
  }
  return Object.freeze(normalized);
}

export function createRedactionPlanRequest({
  sourceSha256,
  expectedWorkspaceRevision,
  targets,
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    profile: SOURCE_BOUND_REDACTION_PLAN_PROFILE,
    sourceSha256: digest(sourceSha256, 'sourceSha256'),
    expectedWorkspaceRevision: revision(expectedWorkspaceRevision),
    targets: uniqueTargets(targets),
  });
}

export function createRedactionApplicationRequest({
  sourceSha256,
  expectedWorkspaceRevision,
  planId,
  planSha256,
  markIds,
} = {}) {
  if (!Array.isArray(markIds) || markIds.length < 1 || markIds.length > 64) {
    throw new TypeError('Choose one to 64 redaction-plan marks.');
  }
  const normalizedIds = markIds.map((value) => opaqueId(value, 'markId'));
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw new TypeError('Redaction-plan mark identifiers must be unique.');
  }
  return Object.freeze({
    schemaVersion: 1,
    profile: SOURCE_BOUND_REDACTION_APPLICATION_PROFILE,
    sourceSha256: digest(sourceSha256, 'sourceSha256'),
    expectedWorkspaceRevision: revision(expectedWorkspaceRevision),
    planId: opaqueId(planId, 'planId'),
    planSha256: digest(planSha256, 'planSha256'),
    markIds: Object.freeze(normalizedIds),
  });
}

export function createRedactionPlanReportRequest({
  sourceSha256,
  expectedWorkspaceRevision,
  planId,
  planSha256,
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    profile: SOURCE_BOUND_REDACTION_PLAN_REPORT_PROFILE,
    sourceSha256: digest(sourceSha256, 'sourceSha256'),
    expectedWorkspaceRevision: revision(expectedWorkspaceRevision),
    planId: opaqueId(planId, 'planId'),
    planSha256: digest(planSha256, 'planSha256'),
  });
}

function validPlanMark(mark) {
  try {
    opaqueId(mark?.id, 'markId');
    if (exactObject(mark, ['id', 'page', 'fullPage']) && mark.fullPage === true) {
      pageNumber(mark.page);
      return true;
    }
    if (exactObject(mark, ['id', 'page', 'region'])) {
      pageNumber(mark.page);
      planRegion(mark.region);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function publicPlanMark(mark) {
  if (validPlanMark(mark)) return structuredClone(mark);
  const fullPageKeys = ['id', 'page', 'fullPage', 'pageGeometrySha256', 'textBinding'];
  const regionKeys = ['id', 'page', 'region', 'pageGeometrySha256', 'textBinding'];
  const binding = mark?.textBinding;
  if (!(exactObject(mark, fullPageKeys) || exactObject(mark, regionKeys))
    || !SHA256.test(mark.pageGeometrySha256 ?? '')
    || !exactObject(binding, ['hmacSha256', 'length'])
    || !SHA256.test(binding.hmacSha256 ?? '')
    || !Number.isSafeInteger(binding.length) || binding.length < 1
    || binding.length > (256 * 1024)) return null;
  const candidate = mark.fullPage === true
    ? { id: mark.id, page: mark.page, fullPage: true }
    : { id: mark.id, page: mark.page, region: structuredClone(mark.region) };
  return validPlanMark(candidate) ? candidate : null;
}

function publicPlan(record) {
  const keys = [
    'id', 'type', 'profile', 'schemaVersion', 'status', 'createdAtLocal',
    'sourceSha256', 'coordinateSpace', 'marks', 'applicationProfile', 'planSha256',
  ];
  if (!exactObject(record, keys) || !Array.isArray(record.marks)) return null;
  const marks = record.marks.map(publicPlanMark);
  if (marks.some((mark) => mark === null)) return null;
  return { ...record, marks };
}

function validPlanMarks(marks) {
  if (!Array.isArray(marks) || marks.length < 1 || marks.length > 64
    || !marks.every(validPlanMark)
    || new Set(marks.map(({ id }) => id)).size !== marks.length) return false;
  const targetKeys = marks.map(({ id: _id, ...target }) => JSON.stringify(target));
  if (new Set(targetKeys).size !== targetKeys.length) return false;
  return !marks.some((mark) => mark.fullPage === true
    && marks.some((candidate) => candidate !== mark && candidate.page === mark.page));
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function isSourceBoundRedactionPlan(plan, sourceSha256) {
  const keys = [
    'id', 'type', 'profile', 'schemaVersion', 'status', 'createdAtLocal',
    'sourceSha256', 'coordinateSpace', 'marks', 'applicationProfile', 'planSha256',
  ];
  return Boolean(
    exactObject(plan, keys)
    && plan.type === 'redaction-plan'
    && plan.schemaVersion === 1
    && plan.profile === SOURCE_BOUND_REDACTION_PLAN_PROFILE
    && plan.status === 'proposed-not-applied'
    && plan.sourceSha256 === sourceSha256
    && plan.coordinateSpace === 'normalized-cropbox-top-left-v1'
    && plan.applicationProfile === VERIFIED_RASTER_BURN_PROFILE
    && canonicalTimestamp(plan.createdAtLocal)
    && OPAQUE_ID.test(plan.id ?? '')
    && SHA256.test(plan.planSha256 ?? '')
    && validPlanMarks(plan.marks)
  );
}

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

function stableCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableCanonicalValue(value[key])]),
    );
  }
  return value;
}

async function canonicalSha256(value) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new TypeError('Redaction-plan report validation requires local SHA-256 support.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(stableCanonicalValue(value)));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sourceBoundRedactionPlans(workspace, sourceSha256) {
  const records = workspace?.namespaces?.redactions;
  if (!Array.isArray(records) || !SHA256.test(sourceSha256 ?? '')) return Object.freeze([]);
  return Object.freeze(records
    .map(publicPlan)
    .filter((plan) => isSourceBoundRedactionPlan(plan, sourceSha256))
    .map((plan) => freezeTree(structuredClone(plan))));
}

export function validateCreatedRedactionPlanResponse(value, sourceSha256) {
  if (!exactObject(value, ['plan', 'revision'])
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !isSourceBoundRedactionPlan(value.plan, sourceSha256)) {
    throw new TypeError('The local host returned an invalid source-bound redaction plan.');
  }
  return freezeTree(structuredClone(value));
}

export function validateAppliedRedactionPlanResponse(value) {
  const artifact = value?.artifact;
  const application = value?.application;
  if (!exactObject(value, ['artifact', 'application'])
    || !artifact || typeof artifact !== 'object'
    || !OPAQUE_ID.test(artifact.id ?? '') || !SHA256.test(artifact.sha256 ?? '')
    || !exactObject(application, ['status', 'planStatus', 'textEvidence'])
    || application.status !== 'artifact-created'
    || application.planStatus !== 'proposed-not-applied'
    || application.textEvidence !== 'validated-transiently-not-retained') {
    throw new TypeError('The local host returned an invalid redaction-plan artifact receipt.');
  }
  return freezeTree(structuredClone(value));
}

export async function validateRedactionPlanReport(value, request) {
  const keys = [
    'schemaVersion', 'profile', 'sourceSha256', 'workspaceRevision', 'planId',
    'planSha256', 'planCreatedAtLocal', 'coordinateSpace', 'applicationProfile',
    'marks', 'reportStatus', 'pdfBytesChanged', 'reportSha256',
  ];
  const normalizedRequest = createRedactionPlanReportRequest(request);
  if (!exactObject(value, keys)
    || value.schemaVersion !== 1
    || value.profile !== SOURCE_BOUND_REDACTION_PLAN_REPORT_PROFILE
    || value.sourceSha256 !== normalizedRequest.sourceSha256
    || value.workspaceRevision !== normalizedRequest.expectedWorkspaceRevision
    || value.planId !== normalizedRequest.planId
    || value.planSha256 !== normalizedRequest.planSha256
    || !canonicalTimestamp(value.planCreatedAtLocal)
    || value.coordinateSpace !== 'normalized-cropbox-top-left-v1'
    || value.applicationProfile !== VERIFIED_RASTER_BURN_PROFILE
    || !validPlanMarks(value.marks)
    || value.reportStatus !== 'proposed-not-applied'
    || value.pdfBytesChanged !== false
    || !SHA256.test(value.reportSha256 ?? '')) {
    throw new TypeError('The local host returned an invalid source-bound redaction-plan report.');
  }
  const { reportSha256, ...unsigned } = value;
  if (await canonicalSha256(unsigned) !== reportSha256) {
    throw new TypeError('The local host returned a redaction-plan report with an invalid canonical digest.');
  }
  return freezeTree(structuredClone(value));
}
