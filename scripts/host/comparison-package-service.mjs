import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import {
  buildComparisonPackage, COMPARISON_PACKAGE_EXTENSION, COMPARISON_PACKAGE_MEDIA_TYPE,
  contentReceiptBytes, visualReceiptEntries,
} from './comparison-package-contract.mjs';

export const COMPARISON_PACKAGE_PROFILE = 'local-comparison-package-v1';

function fail(code, message, status = 422, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Comparison package creation was cancelled.', 499, signal.reason); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function ownData(value, key) {
  if (!value || typeof value !== 'object' || isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function optionsRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) throw new TypeError('Comparison package options are invalid.');
  const allowed = ['primarySha256', 'revisionSha256', 'includeVisual', 'dpi', 'signal'];
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value'))
    || !keys.includes('primarySha256') || !keys.includes('revisionSha256') || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Comparison package options are invalid.');
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function validatePromotedArtifact(artifact, primary, revision, expectedSha256, expectedSize) {
  const operation = ownData(artifact, 'operation'); const inputs = ownData(operation, 'inputs'); const validation = ownData(operation, 'validation');
  const safeInputs = Array.isArray(inputs) && !isProxy(inputs);
  const left = safeInputs ? Object.getOwnPropertyDescriptor(inputs, '0')?.value : null;
  const right = safeInputs ? Object.getOwnPropertyDescriptor(inputs, '1')?.value : null;
  if (!artifact || typeof artifact !== 'object' || isProxy(artifact)
    || typeof ownData(artifact, 'id') !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(ownData(artifact, 'id'))
    || ownData(artifact, 'documentId') !== primary.id || ownData(artifact, 'mediaType') !== COMPARISON_PACKAGE_MEDIA_TYPE
    || ownData(artifact, 'size') !== expectedSize || ownData(artifact, 'sha256') !== expectedSha256
    || typeof ownData(artifact, 'displayName') !== 'string' || !ownData(artifact, 'displayName').endsWith(`.${COMPARISON_PACKAGE_EXTENSION}`)
    || ownData(operation, 'type') !== 'comparison-package' || !safeInputs || inputs.length !== 2
    || ownData(left, 'documentId') !== primary.id || ownData(left, 'sha256') !== primary.sha256 || ownData(left, 'role') !== 'primary'
    || ownData(right, 'documentId') !== revision.id || ownData(right, 'sha256') !== revision.sha256 || ownData(right, 'role') !== 'revision'
    || ownData(validation, 'outputSha256') !== expectedSha256) fail('COMPARISON_PACKAGE_ARTIFACT_INVALID', 'Promoted comparison package artifact does not match the validated output.', 502);
}

export class ComparisonPackageCleanupError extends AggregateError {
  constructor(errors, message = 'Comparison package cleanup failed.') {
    super(errors, message, { cause: new AggregateError(errors, message) });
    this.name = 'ComparisonPackageCleanupError'; this.code = 'COMPARISON_PACKAGE_CLEANUP_FAILED'; this.status = 500;
  }
}

export class ComparisonPackageService {
  #store; #comparison;
  constructor({ store, comparison } = {}) {
    if (!store || !['getDocument', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promoteComparisonPackageArtifact', 'deleteArtifact'].every((name) => typeof store[name] === 'function')) throw new TypeError('ComparisonPackageService requires a source-bound store with comparison-package promotion.');
    if (!comparison || !['compareContent', 'exportContentReport', 'comparePixels'].every((name) => typeof comparison[name] === 'function')) throw new TypeError('ComparisonPackageService requires the verified local comparison service.');
    this.#store = store; this.#comparison = comparison;
  }

  async create(primaryDocumentId, revisionDocumentId, options) {
    const values = optionsRecord(options); const includeVisual = values.includeVisual ?? false; const dpi = values.dpi ?? 72; const signal = values.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (typeof includeVisual !== 'boolean' || !Number.isSafeInteger(dpi) || dpi < 36 || dpi > 240 || (!includeVisual && values.dpi !== undefined)) throw new TypeError('Comparison package visual options are invalid.');
    if (primaryDocumentId === revisionDocumentId) fail('COMPARISON_PACKAGE_SOURCES_INVALID', 'Comparison package sources must be two distinct local PDFs.', 400);
    abort(signal);
    const primary = this.#store.getDocument(primaryDocumentId); const revision = this.#store.getDocument(revisionDocumentId);
    if (values.primarySha256 !== primary.sha256 || values.revisionSha256 !== revision.sha256) fail('COMPARISON_SOURCE_MISMATCH', 'Comparison package source digests do not match the current documents.', 409);
    await this.#verifyPair(primary, revision); abort(signal);
    const contentReport = await this.#comparison.compareContent(primary.id, revision.id, { signal }); abort(signal);
    const content = contentReceiptBytes(this.#comparison.exportContentReport(contentReport, { format: 'json' }), primary.sha256, revision.sha256);
    let visual = null;
    if (includeVisual) {
      const visualReport = await this.#comparison.comparePixels(primary.id, revision.id, { dpi, signal }); abort(signal);
      visual = visualReceiptEntries(visualReport, primary.sha256, revision.sha256);
    }
    await this.#verifyPair(primary, revision); abort(signal);
    const built = buildComparisonPackage({ primary, revision, contentReceipt: content, visual });
    try {
      const workspace = await this.#store.createJobWorkspace(primary.id); let promoted = null; let completed = false; let primaryError = null;
      try {
        const outputPath = join(workspace, `comparison.${COMPARISON_PACKAGE_EXTENSION}`); await writeFile(outputPath, built.bytes, { flag: 'wx', mode: 0o600 });
        const contentSha256 = digest(content); const visualSha256 = visual ? digest(visual.receipt) : null;
        const operation = createOperationProvenance({
          type: 'comparison-package', inputs: [
            { documentId: primary.id, sha256: primary.sha256, role: 'primary' },
            { documentId: revision.id, sha256: revision.sha256, role: 'revision' },
          ], parameters: { profile: COMPARISON_PACKAGE_PROFILE, includeVisual, dpi: includeVisual ? dpi : null, contentReceiptSha256: contentSha256, visualReceiptSha256: visualSha256 },
          expected: { exactlyTwoSources: true, sourcePdfsIncluded: false, localOnly: true, entryCount: built.manifest.entries.length + 1 },
          validation: { passed: true, validators: ['primary-source-sha256', 'revision-source-sha256', 'issued-content-comparison-receipt', ...(includeVisual ? ['bounded-visual-comparison-receipt', 'diff-image-sha256'] : []), 'stored-zip-round-trip', 'manifest-entry-sha256', 'artifact-sha256'], outputSha256: built.sha256, contentReceiptSha256: contentSha256, visualReceiptSha256: visualSha256 },
        });
        abort(signal);
        const candidate = await this.#store.promoteComparisonPackageArtifact(primary.id, revision.id, outputPath, { displayName: `comparison.${COMPARISON_PACKAGE_EXTENSION}`, mediaType: COMPARISON_PACKAGE_MEDIA_TYPE, extension: COMPARISON_PACKAGE_EXTENSION, operation, expectedSha256: built.sha256, signal });
        validatePromotedArtifact(candidate, primary, revision, built.sha256, built.bytes.length); promoted = candidate;
        await this.#verifyPair(primary, revision); abort(signal); completed = true;
        return Object.freeze({ kind: 'comparison-package', schemaVersion: 1, sourceDigests: Object.freeze({ primary: primary.sha256, revision: revision.sha256 }), includeVisual, dpi: includeVisual ? dpi : null, receiptDigests: Object.freeze({ content: contentSha256, visual: visualSha256 }), artifact: promoted, evidence: Object.freeze({ localOnly: true, exactlyTwoSources: true, sourcePdfsIncluded: false, deterministicStoredZip: true }), limitations: Object.freeze(['Contains comparison receipts and optional generated diff PNGs only; source PDF bytes are excluded. Visual and text differences require review.']) });
      } catch (error) {
        primaryError = error; throw error;
      } finally {
        let cleanupError = null; try { await this.#store.cleanupJob(workspace); } catch (error) { cleanupError = error; }
        let revocationError = null;
        if (promoted && (!completed || cleanupError)) { try { await this.#store.deleteArtifact(promoted.id); } catch (error) { revocationError = error; } }
        if (cleanupError || revocationError) throw new ComparisonPackageCleanupError([primaryError, cleanupError, revocationError].filter(Boolean));
      }
    } finally {
      built.bytes.fill(0);
      content.fill(0); visual?.receipt.fill(0); for (const image of visual?.images ?? []) image.bytes.fill(0);
    }
  }

  async #verifyPair(primary, revision) {
    const verified = await Promise.all([
      this.#store.verifySource(primary.id),
      this.#store.verifySource(revision.id),
    ]);
    if (verified.some((value) => value !== true)) {
      fail('SOURCE_INTEGRITY_FAILED', 'A comparison package source could not be verified as unchanged.', 409);
    }
    const rereadPrimary = this.#store.getDocument(primary.id);
    const rereadRevision = this.#store.getDocument(revision.id);
    for (const [before, after] of [[primary, rereadPrimary], [revision, rereadRevision]]) {
      if (!after || after.id !== before.id || after.sha256 !== before.sha256
        || after.size !== before.size || after.mediaType !== before.mediaType) {
        fail('SOURCE_VERSION_MISMATCH', 'A comparison package source changed during processing.', 409);
      }
    }
  }
}
