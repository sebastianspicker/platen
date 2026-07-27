import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { executeOfflineSignatureInspection, parsePageBoxes, parsePdfInfo, parseDocumentUrls, parseTaggedStructure } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { createPdfkitRequestPath } from './adapters/pdfkit.mjs';
import { assertPdfKitFileIdentity, assertPdfKitOutput, assertPdfKitPng, assertPdfKitWorkspace, MAX_PDFKIT_OUTPUT_BYTES, MAX_PDFKIT_SOURCE_BYTES, PDFKIT_WORKSPACE_AFTER_FILES, PDFKIT_WORKSPACE_BEFORE_FILES, pdfKitRectangleWithin, pdfKitPopplerBoxRectangle, pdfKitFileIdentity, writePrivatePdfKitRequest } from './pdfkit-mutation-validation.mjs';
import {
  DEFAULT_TEXT_FIELD_WIDGET_LIMITS,
  digestTextFieldWidgetDefaultValue,
  digestTextFieldWidgetRect,
  normalizeTextFieldWidgetRequest,
  receiptMatchesTextFieldWidgetContract,
  serializeTextFieldWidgetRequest,
  PDFKIT_TEXT_FIELD_WIDGET_PROFILE,
} from './pdfkit-text-field-widget-contract.mjs';

const MAX_JOB_MS = 2 * 60_000;
const TEXT_FIELD_WORKSPACE_SOURCE_FILES = Object.freeze(['input.pdf']);

function fail(code, message, status = 400, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }

function cancelled(signal) {
  if (signal?.aborted) fail('JOB_CANCELLED', 'The text-field widget operation was cancelled.', 499);
}

function createJob(externalSignal) {
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  const controller = new AbortController(); let timedOut = false;
  const onAbort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true }); if (externalSignal?.aborted) onAbort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('Text-field widget deadline exceeded.')); }, MAX_JOB_MS); timer.unref?.();
  return Object.freeze({ signal: controller.signal, get timedOut() { return timedOut; }, dispose() { clearTimeout(timer); externalSignal?.removeEventListener('abort', onAbort); } });
}

function runOptions(workspace, signal, maxStdoutBytes = 512 * 1024) {
  return { cwd: workspace, signal, timeoutMs: 30_000, maxStdoutBytes, maxStderrBytes: 128 * 1024 };
}

function sourceSafety(inspection) {
  return String(inspection?.encrypted).toLowerCase() === 'no'
    && String(inspection?.form).toLowerCase() === 'none'
    && String(inspection?.javascript).toLowerCase() === 'no'
    && String(inspection?.tagged).toLowerCase() === 'no'
    && String(inspection?.suspects).toLowerCase() !== 'yes';
}

async function optionalEvidence(poppler, operation, parameters, options) {
  try { return await poppler.execute(operation, parameters, options); }
  catch (error) {
    if (error instanceof TypeError && /Unknown Poppler operation/u.test(error.message ?? '')) return null;
    throw error;
  }
}

async function rejectUnsafeEvidence(poppler, inputPath, workspace, signal, inspection) {
  if (!sourceSafety(inspection)) fail('PDFKIT_TEXT_FIELD_WIDGET_SOURCE_UNSUPPORTED', 'Text-field authoring requires an unsigned, unencrypted, untagged PDF without forms, JavaScript, or unsafe Poppler evidence.', 422);
  const options = runOptions(workspace, signal);
  const [urlsResult, structureResult] = await Promise.all([
    optionalEvidence(poppler, 'inspectUrls', { input: inputPath }, options),
    optionalEvidence(poppler, 'inspectStructure', { input: inputPath, includeText: false }, options),
  ]);
  if (urlsResult && parseDocumentUrls(urlsResult.stdout).length > 0) fail('PDFKIT_TEXT_FIELD_WIDGET_SOURCE_UNSUPPORTED', 'Text-field authoring rejects action-bearing or external-link PDFs.', 422);
  if (structureResult && parseTaggedStructure(structureResult.stdout).present) fail('PDFKIT_TEXT_FIELD_WIDGET_SOURCE_UNSUPPORTED', 'Text-field authoring rejects tagged or structured PDFs.', 422);
  let signatures;
  try { signatures = await executeOfflineSignatureInspection(poppler, { input: inputPath, nssDirectory: workspace, signal }); }
  catch (error) { fail('PDFKIT_TEXT_FIELD_WIDGET_SOURCE_UNSUPPORTED', 'Text-field authoring rejects signed or indeterminate-signature PDFs.', 422, error); }
  if (signatures.status !== 'unsigned' || signatures.signatureCount !== 0) fail('PDFKIT_TEXT_FIELD_WIDGET_SOURCE_UNSUPPORTED', 'Text-field authoring rejects signed PDFs.', 422);
}

async function validatePageRect(poppler, inputPath, workspace, signal, page, rect) {
  const result = await poppler.execute('inspectPage', { input: inputPath, page }, runOptions(workspace, signal, 256 * 1024));
  const [pageRecord] = parsePageBoxes(result.stdout, { firstPage: page, lastPage: page });
  const crop = pdfKitPopplerBoxRectangle(pageRecord.boxes.cropBox, `the CropBox for page ${page}`);
  if (!pdfKitRectangleWithin(rect, crop)) fail('INVALID_PDFKIT_TEXT_FIELD_WIDGET', 'The field rectangle must be fully contained in the selected page CropBox.');
}

function normalizedResult({ source, artifact, receipt, outputDigest, normalized }) {
  return Object.freeze({
    kind: 'pdfkit-acroform-text-field-widget',
    sourceDigest: source.sha256,
    artifact,
    page: normalized.page,
    fieldNameSha256: receipt.fieldNameSha256,
    defaultValueSha256: receipt.defaultValueSha256,
    rectSha256: receipt.rectSha256,
    evidence: Object.freeze({
      engine: 'Apple PDFKit', helperBinaryDigestVerified: true, sourceDigestReverified: true,
      directAcroFormTopologyVerified: true, terminalTextWidgetVerified: true,
      sourceSafetyVerified: true, preservationVerified: true, reopenedByPdfKit: true,
      popplerPageCountMatched: true, allPagesRendered: true, outputSha256: outputDigest,
      rasterized: false, sourceUnchanged: true,
    }),
    limitations: Object.freeze([
      'This creates exactly one direct terminal text AcroForm widget in a separate derived PDF.',
      'Existing forms, widgets, signatures, encryption, actions, tags, layers, and unsupported PDF graphs are rejected.',
      'Field name and default value are retained only as SHA-256 digests in host results and provenance.',
      'This is not PDF/A, PDF/UA, redaction, sanitization, signature preservation, or byte-preservation validation.',
    ]),
  });
}

export class PdfKitTextFieldWidgetService {
  #store; #poppler; #adapter; #limits;

  constructor({ store, poppler, adapter, limits } = {}) {
    const methods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'];
    if (!store || methods.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfKitTextFieldWidgetService requires a DocumentStore-compatible store.');
    if (!poppler || typeof poppler.execute !== 'function') throw new TypeError('PdfKitTextFieldWidgetService requires a Poppler adapter.');
    if (!adapter || typeof adapter.addTextFieldWidget !== 'function') throw new TypeError('PdfKitTextFieldWidgetService requires a PDFKit text-field adapter.');
    this.#store = store; this.#poppler = poppler; this.#adapter = adapter;
    this.#limits = Object.freeze({ ...DEFAULT_TEXT_FIELD_WIDGET_LIMITS, ...(limits ?? {}) });
  }

  async addTextFieldWidget(documentId, input = {}) {
    const source = this.#store.getDocument(documentId);
    if (!source || typeof source.sha256 !== 'string' || input.sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The text-field widget source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDFKIT_SOURCE_BYTES) fail('PDFKIT_INPUT_TOO_LARGE', 'Text-field widget authoring is limited to bounded PDF sources.', 413);
    const { signal, ...requestInput } = input;
    const job = createJob(signal); let workspace = null; let promoted = null; let complete = false;
    try {
      await this.#store.verifySource(documentId); cancelled(job.signal);
      workspace = await this.#store.createJobWorkspace(documentId);
      const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf'); const requestPath = createPdfkitRequestPath(workspace);
      const sourceIdentity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDFKIT_SOURCE_BYTES, signal: job.signal });
      await assertPdfKitWorkspace(workspace, TEXT_FIELD_WORKSPACE_SOURCE_FILES);
      const sourceInspection = parsePdfInfo((await this.#poppler.execute('inspect', { input: inputPath }, runOptions(workspace, job.signal))).stdout);
      if (sourceInspection.pageCount > this.#limits.maxPages) fail('PDFKIT_PAGE_LIMIT', 'Text-field widget authoring exceeds the page limit.', 422);
      const normalized = normalizeTextFieldWidgetRequest(requestInput, { pageCount: sourceInspection.pageCount });
      await rejectUnsafeEvidence(this.#poppler, inputPath, workspace, job.signal, sourceInspection);
      await validatePageRect(this.#poppler, inputPath, workspace, job.signal, normalized.page, normalized.rect);
      const request = serializeTextFieldWidgetRequest(normalized, this.#limits);
      await writePrivatePdfKitRequest(requestPath, request);
      await assertPdfKitWorkspace(workspace, PDFKIT_WORKSPACE_BEFORE_FILES);
      const requestDigest = createHash('sha256').update(request).digest('hex'); const requestIdentity = await pdfKitFileIdentity(requestPath);
      const receipt = await this.#adapter.addTextFieldWidget({ workspacePath: workspace, requestPath }, { signal: job.signal, timeoutMs: 30_000 });
      await assertPdfKitWorkspace(workspace, PDFKIT_WORKSPACE_AFTER_FILES); await assertPdfKitOutput(outputPath);
      await assertPrivateSourceCopy({ path: inputPath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDFKIT_SOURCE_BYTES });
      await assertPdfKitFileIdentity(requestPath, requestIdentity); if (await digestFile(requestPath) !== requestDigest) fail('PDFKIT_WORKSPACE_INVALID', 'The helper changed its immutable request.', 502);
      const outputIdentity = await pdfKitFileIdentity(outputPath); const outputDigest = await digestFile(outputPath);
      if (!receiptMatchesTextFieldWidgetContract(receipt, normalized) || receipt.outputSha256 !== outputDigest || receipt.sourceSha256 !== source.sha256) fail('PDFKIT_TEXT_FIELD_WIDGET_OUTPUT_INVALID', 'The native text-field receipt did not match the source-bound request.', 502);
      const outputInspection = parsePdfInfo((await this.#poppler.execute('inspect', { input: outputPath }, runOptions(workspace, job.signal))).stdout);
      if (outputInspection.pageCount !== sourceInspection.pageCount || String(outputInspection.encrypted).toLowerCase() !== 'no' || String(outputInspection.form).toLowerCase() !== 'acroform' || String(outputInspection.javascript).toLowerCase() !== 'no' || String(outputInspection.tagged).toLowerCase() !== 'no') fail('PDFKIT_TEXT_FIELD_WIDGET_OUTPUT_INVALID', 'Independent Poppler inspection rejected the derived text-field PDF.', 502);
      for (let page = 1; page <= outputInspection.pageCount; page += 1) {
        cancelled(job.signal); const prefix = join(workspace, `validation-${page}`);
        await this.#poppler.execute('renderPagePng', { input: outputPath, outputPrefix: prefix, page, maxDimension: 256 }, runOptions(workspace, job.signal, 64 * 1024));
        const png = `${prefix}.png`; await assertPdfKitPng(png); await unlink(png);
      }
      await assertPdfKitWorkspace(workspace, PDFKIT_WORKSPACE_AFTER_FILES); await assertPdfKitFileIdentity(outputPath, outputIdentity); if (await digestFile(outputPath) !== outputDigest) fail('PDFKIT_TEXT_FIELD_WIDGET_OUTPUT_INVALID', 'The derived PDF changed during validation.', 502);
      await assertPrivateSourceCopy({ path: inputPath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDFKIT_SOURCE_BYTES }); await this.#store.verifySource(documentId); cancelled(job.signal);
      const provenance = createOperationProvenance({ type: 'pdfkit-acroform-text-field-widget', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDFKIT_TEXT_FIELD_WIDGET_PROFILE, page: normalized.page, fieldNameSha256: receipt.fieldNameSha256, defaultValueSha256: receipt.defaultValueSha256, rectSha256: receipt.rectSha256 }, expected: { pageCount: sourceInspection.pageCount, rasterized: false, editCount: 1 }, validation: { passed: true, validators: ['source-sha256', 'pinned-helper-sha256', 'source-safety', 'direct-acroform-topology', 'terminal-text-widget', 'pdfkit-reopen', 'poppler-page-count', 'poppler-render-all-pages', 'artifact-sha256'], pageCount: outputInspection.pageCount, renderedPages: outputInspection.pageCount, appliedEdits: 1, outputSha256: outputDigest } });
      const stem = basename(source.displayName ?? 'document.pdf', extname(source.displayName ?? 'document.pdf'));
      const artifact = await this.#store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-text-field-widget.pdf`, operation: provenance, expectedSha256: outputDigest, signal: job.signal }); promoted = artifact;
      if (!artifact || artifact.sha256 !== outputDigest || artifact.id === source.id) fail('PDFKIT_TEXT_FIELD_WIDGET_OUTPUT_INVALID', 'The promoted text-field artifact did not match the validated output.', 502);
      complete = true; return normalizedResult({ source, artifact, receipt, outputDigest, normalized });
    } catch (error) {
      if (job.timedOut) throw new HostError('PDFKIT_TEXT_FIELD_WIDGET_TIMEOUT', 'Text-field widget authoring exceeded its two-minute deadline.', 504, { cause: error });
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED') throw new HostError('JOB_CANCELLED', 'The text-field widget operation was cancelled.', 499, { cause: error });
      if (error instanceof HostError) throw error;
      if (['INVALID_REQUEST', 'MUTATION_FAILED'].includes(error?.code)) throw new HostError('PDFKIT_TEXT_FIELD_WIDGET_SOURCE_UNSUPPORTED', 'The pinned helper rejected the source or text-field request.', 422, { cause: error });
      if (error?.code === 'OUTPUT_INVALID') throw new HostError('PDFKIT_TEXT_FIELD_WIDGET_OUTPUT_INVALID', 'The pinned helper could not prove the derived text-field PDF.', 502, { cause: error });
      throw new HostError('PDFKIT_TEXT_FIELD_WIDGET_FAILED', 'The pinned local PDFKit helper could not create a verified text-field PDF.', 502, { cause: error });
    } finally {
      job.dispose();
      const cleanup = workspace ? await Promise.allSettled([this.#store.cleanupJob(workspace)]) : [];
      const cleanupFailed = cleanup.some((result) => result.status === 'rejected');
      if ((!complete || cleanupFailed) && promoted?.id) await this.#store.deleteArtifact(promoted.id).catch(() => {});
    }
  }
}

export const PdfKitTextFieldWidgetAuthoringService = PdfKitTextFieldWidgetService;
