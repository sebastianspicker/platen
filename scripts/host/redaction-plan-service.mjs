import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { MAX_RASTER_JOB_MS, MAX_RASTER_WORKSPACE_BYTES, normalizedRegion, parsePageCount, parsePageDimensions, rasterRegion } from './raster-mutation-contract.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import {
  PdfRedactionBatchService,
  RedactionBatchService,
  REDACTION_BATCH_PROFILE,
  createPdfRedactionBatchService,
  createRedactionBatchService,
} from './pdf-redaction-batch-service.mjs';

const PLAN_PROFILE = 'source-bound-redaction-plan-v1';
const APPLY_PROFILE = 'source-bound-redaction-application-v1';
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const freeze = (value) => Object.freeze(value);
const fail = (code, message, status = 400) => { throw new HostError(code, message, status); };
const canonical = (value) => JSON.stringify(stable(value));
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function normalize(value) { return String(value).trim().replace(/\s+/gu, ' '); }
function exact(value, keys) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)); }
function requestTarget(value, index) {
  if (exact(value, ['page', 'fullPage']) && value.fullPage === true) return freeze({ page: page(value.page), fullPage: true });
  if (exact(value, ['page', 'region']) && exact(value.region, ['x', 'y', 'width', 'height'])) return freeze({ page: page(value.page), region: normalizedRegion(value.region, `targets[${index}].region`) });
  fail('INVALID_REDACTION_PLAN', `Target ${index + 1} must be exactly a full-page or regional target.`);
}
function page(value) { if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_REDACTION_PLAN', 'Target page must be a positive integer.'); return value; }
function targetKey(target) { return canonical({ page: target.page, ...(target.fullPage ? { fullPage: true } : { region: target.region }) }); }
function validRegion(value) { try { normalizedRegion(value, 'mark.region'); return true; } catch { return false; } }
function validMark(mark) {
  const common = ['id', 'page', 'pageGeometrySha256', 'textBinding'];
  const target = exact(mark, [...common, 'fullPage']) && mark.fullPage === true
    ? true : exact(mark, [...common, 'region']) && validRegion(mark.region);
  return target && ID.test(mark.id ?? '') && Number.isSafeInteger(mark.page) && mark.page > 0
    && SHA256.test(mark.pageGeometrySha256 ?? '') && exact(mark.textBinding, ['hmacSha256', 'length'])
    && SHA256.test(mark.textBinding.hmacSha256 ?? '') && Number.isSafeInteger(mark.textBinding.length)
    && mark.textBinding.length > 0 && mark.textBinding.length <= (256 * 1024);
}
function validMarks(marks) {
  if (!Array.isArray(marks) || marks.length < 1 || marks.length > 64 || !marks.every(validMark)
    || new Set(marks.map((mark) => mark.id)).size !== marks.length) return false;
  const targets = new Set();
  for (const mark of marks) {
    const target = { page: mark.page, ...(mark.fullPage ? { fullPage: true } : { region: mark.region }) };
    if (targets.has(targetKey(target)) || (mark.fullPage && marks.some((other) => other !== mark && other.page === mark.page))) return false;
    targets.add(targetKey(target));
  }
  return true;
}
function planDigest(record) { const { planSha256, ...withoutDigest } = record; return digest(withoutDigest); }
function publicPlan(record) { const { marks, ...rest } = record; return freeze({ ...rest, marks: freeze(marks.map(({ textBinding, pageGeometrySha256, ...mark }) => freeze(mark))) }); }

export class RedactionPlanService {
  #documents; #workspace; #poppler; #raster; #key; #clock; #idFactory;
  constructor({ documentStore, workspaceStateStore, poppler, rasterMutations, bindingKey = randomBytes(32), clock = () => new Date().toISOString(), idFactory } = {}) {
    if (!documentStore || !workspaceStateStore || !poppler || !rasterMutations) throw new TypeError('RedactionPlanService requires document, workspace, Poppler, and raster services.');
    if (!Buffer.isBuffer(bindingKey) || bindingKey.length !== 32 || typeof clock !== 'function') throw new TypeError('Redaction plan binding configuration is invalid.');
    this.#documents = documentStore; this.#workspace = workspaceStateStore; this.#poppler = poppler; this.#raster = rasterMutations; this.#key = Buffer.from(bindingKey); this.#clock = clock;
    let serial = 0; this.#idFactory = idFactory ?? (() => `redaction-plan-${++serial}`); if (typeof this.#idFactory !== 'function') throw new TypeError('idFactory must be a function.');
  }
  async createPlan(documentId, request, { signal } = {}) {
    this.#assertActive(signal);
    const checked = this.#createRequest(request); const source = this.#source(documentId, checked.sourceSha256);
    const workspace = await this.#documents.createJobWorkspace(documentId); let sourcePath;
    try {
      const staged = await this.#stage(documentId, source, workspace); sourcePath = staged.path; const geometry = await this.#geometry(sourcePath, signal);
      const marks = [];
      for (const [index, target] of checked.targets.entries()) marks.push(await this.#makeMark(sourcePath, source.sha256, target, geometry, index, signal));
      if (new Set(marks.map((mark) => mark.id)).size !== marks.length) fail('INVALID_PLAN_ID', 'Redaction mark identifiers must be unique.', 500);
      const record = { id: this.#id('redaction-plan'), type: 'redaction-plan', profile: PLAN_PROFILE, schemaVersion: 1, status: 'proposed-not-applied', createdAtLocal: this.#clock(), sourceSha256: source.sha256, coordinateSpace: 'normalized-cropbox-top-left-v1', marks, applicationProfile: 'verified-raster-burn-v2' };
      record.planSha256 = planDigest(record); await this.#assertStaged(sourcePath, staged.identity, source); await this.#documents.verifySource(documentId);
      const snapshot = this.#workspace.createEntity(documentId, 'redactions', record, { expectedRevision: checked.expectedWorkspaceRevision });
      return freeze({ plan: publicPlan(record), revision: snapshot.revision });
    } catch (error) { this.#cancelled(signal, error); throw error; } finally { await this.#documents.cleanupJob(workspace).catch(() => {}); }
  }
  async applyPlan(documentId, request, { signal } = {}) {
    this.#assertActive(signal);
    const checked = this.#applyRequest(request); const lease = this.#workspace.acquireReadLease(documentId, { expectedRevision: checked.expectedWorkspaceRevision }); let artifact = null; let excerpt = null;
    try {
      const record = this.#resolve(lease.snapshot, checked); const source = this.#source(documentId, checked.sourceSha256);
      const workspace = await this.#documents.createJobWorkspace(documentId);
      try {
        const staged = await this.#stage(documentId, source, workspace); const sourcePath = staged.path; const geometry = await this.#geometry(sourcePath, signal);
        const selected = record.marks.filter((mark) => checked.markIds.includes(mark.id));
        excerpt = await this.#verifyMarks(sourcePath, source.sha256, selected, geometry, signal);
        await this.#assertStaged(sourcePath, staged.identity, source);
        const planBinding = freeze({ profile: PLAN_PROFILE, planId: record.id, planSha256: record.planSha256, markIds: checked.markIds, workspaceRevision: checked.expectedWorkspaceRevision, geometryBindingSha256: digest(selected.map(({ id, page, fullPage, region, pageGeometrySha256 }) => ({ id, page, fullPage, region, pageGeometrySha256 }))) });
        artifact = await this.#raster.redact(documentId, { profile: 'verified-raster-burn-v2', sourceSha256: source.sha256, redactions: selected.map((mark, index) => ({ page: mark.page, ...(mark.fullPage ? { fullPage: true } : { region: mark.region }), removedText: excerpt[index] })), planBinding }, { signal });
      } finally { excerpt = null; await this.#documents.cleanupJob(workspace).catch(() => {}); }
      lease.assertCurrent(); this.#source(documentId, checked.sourceSha256); await this.#documents.verifySource(documentId); if (this.#resolve(this.#workspace.snapshot(documentId), checked).planSha256 !== checked.planSha256) fail('PLAN_TAMPERED', 'The source-bound redaction plan changed during application.', 409);
      return freeze({ artifact, application: freeze({ status: 'artifact-created', planStatus: 'proposed-not-applied', textEvidence: 'validated-transiently-not-retained' }) });
    } catch (error) { await this.#rollback(artifact, error); this.#cancelled(signal, error); throw error; } finally { lease.release(); }
  }
  #createRequest(value) { if (!exact(value, ['schemaVersion', 'profile', 'sourceSha256', 'expectedWorkspaceRevision', 'targets']) || value.schemaVersion !== 1 || value.profile !== PLAN_PROFILE || !SHA256.test(value.sourceSha256) || !Number.isSafeInteger(value.expectedWorkspaceRevision) || value.expectedWorkspaceRevision < 0 || !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 64) fail('INVALID_REDACTION_PLAN', 'Redaction plan request must use the exact versioned contract.'); const targets = value.targets.map(requestTarget); const seen = new Set(); for (const target of targets) { if (seen.has(targetKey(target)) || (target.fullPage && targets.some((other) => other.page === target.page && other !== target))) fail('INVALID_REDACTION_PLAN', 'Redaction targets must not duplicate or overlap a full-page target.'); seen.add(targetKey(target)); } return freeze({ ...value, targets: freeze(targets) }); }
  #applyRequest(value) { if (!exact(value, ['schemaVersion', 'profile', 'sourceSha256', 'expectedWorkspaceRevision', 'planId', 'planSha256', 'markIds']) || value.schemaVersion !== 1 || value.profile !== APPLY_PROFILE || !SHA256.test(value.sourceSha256) || !Number.isSafeInteger(value.expectedWorkspaceRevision) || value.expectedWorkspaceRevision < 0 || !ID.test(value.planId) || !SHA256.test(value.planSha256) || !Array.isArray(value.markIds) || value.markIds.length < 1 || value.markIds.length > 64 || new Set(value.markIds).size !== value.markIds.length || value.markIds.some((id) => !ID.test(id))) fail('INVALID_REDACTION_APPLICATION', 'Redaction application request must use the exact versioned contract.'); return freeze({ ...value, markIds: freeze([...value.markIds]) }); }
  #source(documentId, expectedSha256) { const source = this.#documents.getDocument(documentId); if (source.sha256 !== expectedSha256) fail('SOURCE_VERSION_MISMATCH', 'The request does not match the immutable source digest.', 409); return source; }
  async #stage(documentId, source, workspace) { await this.#documents.verifySource(documentId); const path = join(workspace, 'source-bound.pdf'); try { const identity = await stagePrivateSourceCopy({ sourcePath: this.#documents.getSourcePath(documentId), targetPath: path, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_RASTER_WORKSPACE_BYTES }); await this.#assertStaged(path, identity, source); return freeze({ path, identity }); } catch (error) { throw new HostError('SOURCE_INTEGRITY_FAILED', 'Redaction plan could not stage the immutable source.', 500, { cause: error }); } }
  async #assertStaged(path, identity, source) { try { await assertPrivateSourceCopy({ path, identity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_RASTER_WORKSPACE_BYTES }); } catch (error) { throw new HostError('SOURCE_INTEGRITY_FAILED', 'The staged redaction source changed during inspection.', 500, { cause: error }); } }
  async #geometry(input, signal) { const info = await this.#poppler.execute('inspect', { input }, { signal, timeoutMs: MAX_RASTER_JOB_MS }); const count = parsePageCount(info.stdout); const pages = new Map(); for (let number = 1; number <= count; number += 1) { const result = await this.#poppler.execute('inspectPage', { input, page: number }, { signal, timeoutMs: MAX_RASTER_JOB_MS }); const value = parsePageDimensions(result.stdout, number); if (value.rotation !== 0 || !value.cropMatchesMedia) fail('REDACTION_PAGE_GEOMETRY_UNSUPPORTED', 'Source-bound redaction requires unrotated pages with CropBox equal to MediaBox.', 422); pages.set(number, freeze({ text: freeze({ width: Math.ceil(value.cropWidthPoints), height: Math.ceil(value.cropHeightPoints) }), digest: digest(value) })); } return pages; }
  async #makeMark(input, sourceSha256, target, geometry, index, signal) { const pageGeometry = geometry.get(target.page); if (!pageGeometry) fail('INVALID_REDACTION_PLAN', 'A target page does not exist.'); const region = target.fullPage ? freeze({ x: 0, y: 0, width: 1, height: 1 }) : target.region; const text = await this.#extract(input, target.page, region, pageGeometry, signal); const id = this.#id(`redaction-mark-${index + 1}`); return freeze({ id, page: target.page, ...(target.fullPage ? { fullPage: true } : { region }), pageGeometrySha256: pageGeometry.digest, textBinding: freeze({ hmacSha256: this.#binding(sourceSha256, target.page, region, pageGeometry.digest, text), length: text.length }) }); }
  async #verifyMarks(input, sourceSha256, marks, geometry, signal) { const excerpts = []; for (const mark of marks) { const pageGeometry = geometry.get(mark.page); if (!pageGeometry || pageGeometry.digest !== mark.pageGeometrySha256) fail('PLAN_TAMPERED', 'The source page geometry no longer matches the plan.', 409); const region = mark.fullPage ? freeze({ x: 0, y: 0, width: 1, height: 1 }) : mark.region; const text = await this.#extract(input, mark.page, region, pageGeometry, signal); const expected = this.#binding(sourceSha256, mark.page, region, pageGeometry.digest, text); if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mark.textBinding.hmacSha256, 'hex')) || text.length !== mark.textBinding.length) fail('PLAN_TEXT_BINDING_FAILED', 'The source text no longer matches the redaction plan.', 409); excerpts.push(text.slice(0, 256)); } return excerpts; }
  async #extract(input, pageNumber, region, pageGeometry, signal) { const result = await this.#poppler.execute('extractTextRegion', { input, page: pageNumber, region: rasterRegion(region, pageGeometry.text) }, { signal, timeoutMs: MAX_RASTER_JOB_MS, maxStdoutBytes: 256 * 1024 }); const text = normalize(result.stdout); if (!text) fail('REDACTION_TEXT_NOT_FOUND', 'Each redaction target must contain normalized source text.', 422); return text; }
  #binding(sourceSha256, pageNumber, region, geometryDigest, text) { return createHmac('sha256', this.#key).update(canonical({ sourceSha256, pageNumber, region, geometryDigest, text })).digest('hex'); }
  #id(prefix) { const value = this.#idFactory(prefix); if (!ID.test(value ?? '')) fail('INVALID_PLAN_ID', 'Redaction plan identifiers must be opaque bounded values.', 500); return value; }
  async #rollback(artifact, original) { if (!artifact) return; try { await this.#documents.deleteArtifact(artifact.id); } catch (rollback) { throw new HostError('REDACTION_ARTIFACT_ROLLBACK_FAILED', 'A failed redaction application could not remove its derived artifact.', 500, { cause: new AggregateError([original, rollback]) }); } }
  #assertActive(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Redaction plan operation was cancelled.', 499); }
  #cancelled(signal, error) { if (signal?.aborted || error?.code === 'ENGINE_CANCELLED') fail('JOB_CANCELLED', 'Redaction plan operation was cancelled.', 499); }
  #resolve(snapshot, request) {
    const record = snapshot.namespaces.redactions.find((entry) => entry.id === request.planId);
    const keys = ['id', 'type', 'profile', 'schemaVersion', 'status', 'createdAtLocal', 'sourceSha256', 'coordinateSpace', 'marks', 'applicationProfile', 'planSha256'];
    const strict = exact(record, keys) && ID.test(record.id) && record.type === 'redaction-plan'
      && record.profile === PLAN_PROFILE && record.schemaVersion === 1 && record.status === 'proposed-not-applied'
      && typeof record.createdAtLocal === 'string' && record.createdAtLocal.length > 0 && record.createdAtLocal.length <= 100
      && SHA256.test(record.sourceSha256) && record.coordinateSpace === 'normalized-cropbox-top-left-v1'
      && record.applicationProfile === 'verified-raster-burn-v2' && SHA256.test(record.planSha256)
      && validMarks(record.marks);
    if (!strict) fail('LEGACY_REDACTION_PLAN_REJECTED', 'Only strict current source-bound redaction plans can be applied.', 409);
    if (record.sourceSha256 !== request.sourceSha256 || record.planSha256 !== request.planSha256 || planDigest(record) !== record.planSha256) fail('PLAN_TAMPERED', 'The source-bound redaction plan does not match its digest.', 409);
    if (!request.markIds.every((id) => record.marks.some((mark) => mark.id === id))) fail('INVALID_REDACTION_APPLICATION', 'Requested marks are not part of the source-bound plan.');
    return record;
  }
}

// Keep the batch wrapper on the existing redaction production surface without
// coupling its execution into the single-document plan service.
export {
  PdfRedactionBatchService,
  RedactionBatchService,
  REDACTION_BATCH_PROFILE,
  createPdfRedactionBatchService,
  createRedactionBatchService,
};
