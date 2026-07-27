import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';
import { normalizedRegion } from './raster-mutation-contract.mjs';

export const REDACTION_PLAN_REPORT_PROFILE = 'source-bound-redaction-plan-report-v1';

const PLAN_PROFILE = 'source-bound-redaction-plan-v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_KEYS = ['id', 'type', 'profile', 'schemaVersion', 'status', 'createdAtLocal', 'sourceSha256', 'coordinateSpace', 'marks', 'applicationProfile', 'planSha256'];
const REQUEST_KEYS = ['schemaVersion', 'profile', 'sourceSha256', 'expectedWorkspaceRevision', 'planId', 'planSha256'];
const MAX_REPORT_BYTES = 64 * 1024;

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function exact(value, keys) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)); }
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function canonical(value) { return JSON.stringify(stable(value)); }
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function page(value) { return Number.isSafeInteger(value) && value >= 1 && value <= 10_000; }
function validRegion(value) { try { normalizedRegion(value, 'mark.region'); return true; } catch { return false; } }
function overlaps(first, second) {
  if (first.page !== second.page) return false;
  if (first.fullPage || second.fullPage) return true;
  return first.region.x < second.region.x + second.region.width
    && second.region.x < first.region.x + first.region.width
    && first.region.y < second.region.y + second.region.height
    && second.region.y < first.region.y + first.region.height;
}
function validMark(mark) {
  const common = ['id', 'page', 'pageGeometrySha256', 'textBinding'];
  const target = exact(mark, [...common, 'fullPage']) && mark.fullPage === true
    ? true : exact(mark, [...common, 'region']) && validRegion(mark.region);
  return target && ID.test(mark.id ?? '') && page(mark.page) && SHA256.test(mark.pageGeometrySha256 ?? '')
    && exact(mark.textBinding, ['hmacSha256', 'length']) && SHA256.test(mark.textBinding.hmacSha256 ?? '')
    && Number.isSafeInteger(mark.textBinding.length) && mark.textBinding.length > 0 && mark.textBinding.length <= (256 * 1024);
}
function validMarks(marks) {
  if (!Array.isArray(marks) || marks.length < 1 || marks.length > 64 || !marks.every(validMark)
    || new Set(marks.map((mark) => mark.id)).size !== marks.length) return false;
  return !marks.some((mark, index) => marks.slice(index + 1).some((other) => overlaps(mark, other)));
}
function planDigest(record) { const { planSha256, ...unsigned } = record; return digest(unsigned); }
function publicTimestamp(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value ? null : value;
}
function publicMarks(marks) {
  return Object.freeze(marks.map((mark) => Object.freeze(mark.fullPage
    ? { id: mark.id, page: mark.page, fullPage: true }
    : { id: mark.id, page: mark.page, region: Object.freeze({ ...mark.region }) })));
}
function freezeTree(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freezeTree(child); } return value; }

/** Exports one verified source-bound proposal as a non-application public report. */
export class RedactionPlanReportService {
  #documents; #workspace;

  constructor({ documentStore, workspaceStateStore } = {}) {
    if (!documentStore || typeof documentStore.getDocument !== 'function' || typeof documentStore.verifySource !== 'function') throw new TypeError('RedactionPlanReportService requires a DocumentStore-compatible store.');
    if (!workspaceStateStore || typeof workspaceStateStore.acquireReadLease !== 'function') throw new TypeError('RedactionPlanReportService requires a WorkspaceStateStore-compatible store.');
    this.#documents = documentStore; this.#workspace = workspaceStateStore;
  }

  async report(documentId, request, { signal } = {}) {
    this.#assertActive(signal);
    const checked = this.#request(request);
    const lease = this.#workspace.acquireReadLease(documentId, { expectedRevision: checked.expectedWorkspaceRevision });
    try {
      const source = this.#source(documentId, checked.sourceSha256);
      await this.#documents.verifySource(documentId);
      this.#assertActive(signal);
      const plan = this.#plan(lease.snapshot, checked);
      lease.assertCurrent();
      this.#source(documentId, checked.sourceSha256);
      await this.#documents.verifySource(documentId);
      this.#assertActive(signal);
      const unsigned = {
        schemaVersion: 1,
        profile: REDACTION_PLAN_REPORT_PROFILE,
        sourceSha256: source.sha256,
        workspaceRevision: lease.revision,
        planId: plan.id,
        planSha256: plan.planSha256,
        ...(publicTimestamp(plan.createdAtLocal) === null ? {} : { planCreatedAtLocal: plan.createdAtLocal }),
        coordinateSpace: plan.coordinateSpace,
        applicationProfile: plan.applicationProfile,
        marks: publicMarks(plan.marks),
        reportStatus: 'proposed-not-applied',
        pdfBytesChanged: false,
      };
      const report = { ...unsigned, reportSha256: digest(unsigned) };
      if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_REPORT_BYTES) {
        fail('REDACTION_PLAN_REPORT_TOO_LARGE', 'Redaction plan report exceeds its fixed 64 KiB limit.', 413);
      }
      return freezeTree(report);
    } catch (error) {
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED') fail('JOB_CANCELLED', 'Redaction plan report export was cancelled.', 499);
      throw error;
    } finally { lease.release(); }
  }

  #request(value) {
    if (!exact(value, REQUEST_KEYS) || value.schemaVersion !== 1 || value.profile !== REDACTION_PLAN_REPORT_PROFILE
      || !SHA256.test(value.sourceSha256) || !Number.isSafeInteger(value.expectedWorkspaceRevision) || value.expectedWorkspaceRevision < 0
      || !ID.test(value.planId ?? '') || !SHA256.test(value.planSha256)) {
      fail('INVALID_REDACTION_PLAN_REPORT', 'Redaction plan report request must use the exact versioned contract.');
    }
    return Object.freeze({ ...value });
  }

  #source(documentId, expectedSha256) {
    const source = this.#documents.getDocument(documentId);
    if (source.sha256 !== expectedSha256) fail('SOURCE_VERSION_MISMATCH', 'The request does not match the immutable source digest.', 409);
    return source;
  }

  #plan(snapshot, request) {
    const record = snapshot?.namespaces?.redactions?.find((entry) => entry.id === request.planId);
    const strict = exact(record, PLAN_KEYS) && ID.test(record.id ?? '') && record.type === 'redaction-plan'
      && record.profile === PLAN_PROFILE && record.schemaVersion === 1 && record.status === 'proposed-not-applied'
      && publicTimestamp(record.createdAtLocal) !== null
      && SHA256.test(record.sourceSha256 ?? '') && record.coordinateSpace === 'normalized-cropbox-top-left-v1'
      && record.applicationProfile === 'verified-raster-burn-v2' && SHA256.test(record.planSha256 ?? '') && validMarks(record.marks);
    if (!strict) fail('LEGACY_REDACTION_PLAN_REJECTED', 'Only strict current source-bound redaction plans can be reported.', 409);
    if (record.sourceSha256 !== request.sourceSha256 || record.planSha256 !== request.planSha256 || planDigest(record) !== record.planSha256) fail('PLAN_TAMPERED', 'The source-bound redaction plan does not match its digest.', 409);
    return record;
  }

  #assertActive(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Redaction plan report export was cancelled.', 499); }
}
