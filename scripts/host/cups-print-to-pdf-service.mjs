import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createCupsfilterAdapter } from './adapters/cupsfilter.mjs';
import { readRegularOutput } from './bounded-output-io.mjs';
import { runConversionJob } from './conversion-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { createOperationProvenance, validateOperationProvenance } from './operation-provenance.mjs';
import { parsePageDimensions, parsePdfInfo, parseTextPages } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';

export const MAX_CUPS_TEXT_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_CUPS_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_CUPS_PDF_PAGES = 64;
const MAX_TEXT_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_POINTS = 14_400;
const SHA256 = /^[a-f0-9]{64}$/u;
const VALIDATORS = Object.freeze(['source-sha256', 'cupsfilter-cgtexttopdf', 'pdfinfo-page-count', 'pdfinfo-passive']);
const SHORT_IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);

function invalid(code, message, status = 422, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function cancelled(signal) { if (signal?.aborted) { const error = new Error('CUPS text-to-PDF conversion was cancelled.'); error.code = 'ENGINE_CANCELLED'; throw error; } }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameIdentity(left, right) { return SHORT_IDENTITY_KEYS.every((key) => left[key] === right[key]); }
function shortIdentity(metadata) { return Object.freeze(Object.fromEntries(SHORT_IDENTITY_KEYS.map((key) => [key, metadata[key]]))); }
function text(bytes) {
  if (bytes.includes(0)) invalid('INVALID_CUPS_TEXT_INPUT', 'Text input must not contain NUL bytes.', 415);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) { invalid('INVALID_CUPS_TEXT_INPUT', 'Text input must be strict UTF-8.', 415, error); }
}
function assertAsset(asset) {
  if (!asset || asset.kind !== 'text' || asset.extension !== '.txt' || asset.mediaType !== 'text/plain'
    || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_CUPS_TEXT_INPUT_BYTES || !SHA256.test(asset.sha256 ?? '')) {
    invalid('UNSUPPORTED_CUPS_TEXT_INPUT', 'Print-to-PDF accepts only bounded text/plain .txt input.', 415);
  }
}
function runOptions(workspace, signal, bytes, timeoutMs = 20_000, output = 512 * 1024) {
  return { cwd: workspace, signal, stdin: bytes, maxStdinBytes: MAX_CUPS_PDF_BYTES, timeoutMs, maxStdoutBytes: output, maxStderrBytes: 128 * 1024 };
}
function passive(inspection) { return inspection?.encrypted === 'no' && inspection.javascript === 'no' && inspection.form === 'none'; }
function assertEvidence(inspection, pages, textPages) {
  if (!Number.isSafeInteger(inspection?.pageCount) || inspection.pageCount < 1 || inspection.pageCount > MAX_CUPS_PDF_PAGES || !passive(inspection)) {
    invalid('INVALID_CUPS_PDF_DOCUMENT', 'CUPS did not produce a bounded passive PDF.', 502);
  }
  if (pages.length !== inspection.pageCount || pages.some((page, index) => page?.page !== index + 1
    || !Number.isFinite(page?.widthPoints) || !Number.isFinite(page?.heightPoints)
    || page.widthPoints <= 0 || page.heightPoints <= 0
    || page.widthPoints > MAX_POINTS || page.heightPoints > MAX_POINTS)) {
    invalid('INVALID_CUPS_PDF_DOCUMENT', 'CUPS PDF page geometry is invalid.', 502);
  }
  let total = 0;
  if (textPages.length !== inspection.pageCount || textPages.some((page, index) => {
    if (page?.page !== index + 1 || typeof page?.text !== 'string') return true;
    total += Buffer.byteLength(page.text, 'utf8'); return total > MAX_TEXT_EVIDENCE_BYTES;
  })) invalid('CUPS_PDF_TEXT_LIMIT', 'CUPS PDF text evidence is invalid or exceeds the bounded limit.', 502);
}
async function stagedInput(inputs, asset, workspace, signal) {
  const source = join(workspace, 'immutable-source.txt');
  await inputs.verifyInput(asset.id);
  let identity;
  try {
    if (asset.size >= 5) {
      identity = await stagePrivateSourceCopy({ sourcePath: inputs.getSourcePath(asset.id), targetPath: source, expectedSha256: asset.sha256, expectedSize: asset.size, maximumBytes: MAX_CUPS_TEXT_INPUT_BYTES, signal });
    } else {
      identity = await stageShortText(inputs.getSourcePath(asset.id), source, asset, signal);
    }
  } catch (error) { invalid('SOURCE_INTEGRITY_FAILED', 'Print-to-PDF could not stage the immutable text input.', 500, error); }
  const bytes = await readRegularOutput(source, { minimumBytes: 1, maximumBytes: MAX_CUPS_TEXT_INPUT_BYTES, label: 'Private text input' });
  if (digest(bytes) !== asset.sha256) invalid('SOURCE_INTEGRITY_FAILED', 'Print-to-PDF text input changed during staging.', 500);
  text(bytes); return { source, identity, bytes };
}
async function assertStaged(source, identity, asset) {
  try {
    if (asset.size >= 5) await assertPrivateSourceCopy({ path: source, identity, expectedSha256: asset.sha256, expectedSize: asset.size, maximumBytes: MAX_CUPS_TEXT_INPUT_BYTES });
    else await assertShortText(source, identity, asset);
  }
  catch (error) { invalid('SOURCE_INTEGRITY_FAILED', 'Print-to-PDF private text input changed during conversion.', 500, error); }
}
async function stageShortText(sourcePath, targetPath, asset, signal) {
  let source; let target;
  try {
    if (signal?.aborted) cancelled(signal);
    source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(asset.size)) throw new Error('Input is not a stable regular file.');
    const bytes = Buffer.alloc(asset.size);
    if ((await source.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length || (await source.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) throw new Error('Input changed while being staged.');
    if (digest(bytes) !== asset.sha256 || !sameIdentity(before, await source.stat({ bigint: true }))) throw new Error('Input identity changed while being staged.');
    target = await open(targetPath, 'wx', 0o600); await target.writeFile(bytes); await target.sync(); await target.chmod(0o400);
    const metadata = await target.stat({ bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size !== BigInt(asset.size) || (metadata.mode & 0o077n) !== 0n) throw new Error('Private staging copy is invalid.');
    return shortIdentity(metadata);
  } finally { await Promise.all([source?.close().catch(() => {}), target?.close().catch(() => {})]); }
}
async function assertShortText(path, identity, asset) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(asset.size) || !sameIdentity(before, identity) || (before.mode & 0o077n) !== 0n) throw new Error('Private short source identity changed.');
    const bytes = Buffer.alloc(asset.size);
    if ((await handle.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length || digest(bytes) !== asset.sha256 || !sameIdentity(before, await handle.stat({ bigint: true }))) throw new Error('Private short source changed.');
  } finally { await handle?.close().catch(() => {}); }
}
async function writeOutput(path, bytes) {
  let handle;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { invalid('CUPS_FILTER_OUTPUT_INVALID', 'The local CUPS filter output could not be retained safely.', 502, error); }
  finally { await handle?.close().catch(() => {}); }
}
async function inspectPdf(poppler, workspace, signal, bytes) {
  const inspection = parsePdfInfo((await poppler.execute('inspectStdin', {}, runOptions(workspace, signal, bytes))).stdout);
  if (!Number.isSafeInteger(inspection.pageCount) || inspection.pageCount < 1
    || inspection.pageCount > MAX_CUPS_PDF_PAGES) {
    invalid('INVALID_CUPS_PDF_DOCUMENT', 'CUPS did not produce a bounded page count.', 502);
  }
  const pages = [];
  for (let page = 1; page <= inspection.pageCount; page += 1) pages.push(parsePageDimensions((await poppler.execute('inspectPageStdin', { page }, runOptions(workspace, signal, bytes))).stdout, page));
  const textPages = parseTextPages(
    (await poppler.execute('extractTextStdin', { layout: true }, runOptions(
      workspace, signal, bytes, 30_000, MAX_TEXT_EVIDENCE_BYTES,
    ))).stdout,
    inspection.pageCount,
  );
  assertEvidence(inspection, pages, textPages); return Object.freeze({ inspection, pages: Object.freeze(pages), textPages });
}
function operation(asset, pageCount) {
  return createOperationProvenance({ type: 'cups-text-to-pdf', inputs: [{ assetId: asset.id, sha256: asset.sha256, role: 'source' }], parameters: { sourceFormat: 'txt', sourceMediaType: 'text/plain', filter: 'cgtexttopdf' }, expected: { minimumPageCount: 1, maximumPageCount: MAX_CUPS_PDF_PAGES }, validation: { passed: true, validators: VALIDATORS, pageCount } });
}
function assertDocument(document) {
  let op; try { op = validateOperationProvenance(document?.operation); } catch { invalid('INVALID_CUPS_PDF_DOCUMENT', 'Only a CUPS-produced text PDF can be exported.', 403); }
  const input = op.inputs[0]; const p = op.parameters;
  if (document?.origin !== 'derived' || document.mediaType !== 'application/pdf'
    || !SHA256.test(document.sha256 ?? '') || !Number.isSafeInteger(document.size)
    || document.size < 5 || document.size > MAX_CUPS_PDF_BYTES || op.type !== 'cups-text-to-pdf'
    || op.inputs.length !== 1 || !input?.assetId || !SHA256.test(input.sha256 ?? '')
    || Object.keys(p ?? {}).length !== 3 || p?.sourceFormat !== 'txt' || p.sourceMediaType !== 'text/plain' || p.filter !== 'cgtexttopdf'
    || op.validation?.passed !== true || !Number.isSafeInteger(op.validation?.pageCount)
    || op.validation.pageCount < 1 || op.validation.pageCount > MAX_CUPS_PDF_PAGES
    || JSON.stringify(op.validation.validators) !== JSON.stringify(VALIDATORS)
    || Object.keys(op.expected ?? {}).length !== 2 || op.expected.minimumPageCount !== 1
    || op.expected.maximumPageCount !== MAX_CUPS_PDF_PAGES) invalid('INVALID_CUPS_PDF_DOCUMENT', 'Only an exact CUPS text-to-PDF result can be exported.', 403);
  return op;
}

export class CupsPrintToPdfService {
  #inputs; #documents; #poppler; #cupsfilter;
  constructor({ inputs, documents, poppler, cupsfilter = createCupsfilterAdapter() }) {
    if (!inputs?.getInput || !inputs?.verifyInput || !documents?.createDocument || !poppler?.execute || !cupsfilter?.verifyPlan || !cupsfilter?.convert) throw new TypeError('CUPS print-to-PDF dependencies are invalid.');
    this.#inputs = inputs; this.#documents = documents; this.#poppler = poppler; this.#cupsfilter = cupsfilter;
  }
  async convertInput(assetId, { signal: externalSignal } = {}) {
    const asset = this.#inputs.getInput(assetId); assertAsset(asset);
    const owner = Object.freeze({ createJobWorkspace: this.#inputs.createJobWorkspace.bind(this.#inputs), cleanupJob: this.#inputs.cleanupJob.bind(this.#inputs), verifySource: this.#inputs.verifyInput.bind(this.#inputs), deleteDocument: this.#documents.deleteDocument.bind(this.#documents) });
    return runConversionJob({ owner, resourceId: assetId, externalSignal, action: async ({ workspace, signal, checkQuota, registerPromotedDocument }) => {
      const staged = await stagedInput(this.#inputs, asset, workspace, signal); await assertStaged(staged.source, staged.identity, asset); await this.#cupsfilter.verifyPlan({ sourcePath: staged.source, cwd: workspace, signal });
      await this.#inputs.verifyInput(asset.id); cancelled(signal); const raw = await this.#cupsfilter.convert({ sourcePath: staged.source, cwd: workspace, signal }); await assertStaged(staged.source, staged.identity, asset); await this.#inputs.verifyInput(asset.id);
      const output = join(workspace, 'cups-output.pdf'); await writeOutput(output, raw); const bytes = await readRegularOutput(output, { minimumBytes: 5, maximumBytes: MAX_CUPS_PDF_BYTES, label: 'CUPS PDF output' }); if (!bytes.equals(raw)) invalid('CUPS_FILTER_OUTPUT_INVALID', 'The local CUPS filter output changed during retention.', 502);
      const evidence = await inspectPdf(this.#poppler, workspace, signal, bytes); await checkQuota(); await assertStaged(staged.source, staged.identity, asset); await this.#inputs.verifyInput(asset.id); cancelled(signal);
      const document = await this.#documents.createDocument({ stream: Readable.from([bytes]), displayName: `${asset.displayName.slice(0, -4)}.pdf`, operation: operation(asset, evidence.inspection.pageCount) }); registerPromotedDocument(document); return document;
    } });
  }
  async prepareRetainedArtifactExport(documentId, { signal: externalSignal } = {}) {
    const document = this.#documents.getDocument(documentId); const provenance = assertDocument(document);
    return runConversionJob({ owner: this.#documents, resourceId: documentId, externalSignal, action: async ({ workspace, signal, checkQuota }) => {
      const source = join(workspace, 'immutable-cups-pdf.pdf'); await this.#documents.verifySource(documentId); const identity = await stagePrivateSourceCopy({ sourcePath: this.#documents.getSourcePath(documentId), targetPath: source, expectedSha256: document.sha256, expectedSize: document.size, maximumBytes: MAX_CUPS_PDF_BYTES, signal }); const bytes = await readRegularOutput(source, { minimumBytes: 5, maximumBytes: MAX_CUPS_PDF_BYTES, label: 'CUPS PDF snapshot' }); if (digest(bytes) !== document.sha256) invalid('SOURCE_INTEGRITY_FAILED', 'CUPS PDF snapshot changed during export.', 500);
      await assertPrivateSourceCopy({ path: source, identity, expectedSha256: document.sha256, expectedSize: document.size, maximumBytes: MAX_CUPS_PDF_BYTES }); const evidence = await inspectPdf(this.#poppler, workspace, signal, bytes); if (evidence.inspection.pageCount !== provenance.validation.pageCount) invalid('INVALID_CUPS_PDF_DOCUMENT', 'CUPS PDF page count changed during export.', 502); await checkQuota(); await assertPrivateSourceCopy({ path: source, identity, expectedSha256: document.sha256, expectedSize: document.size, maximumBytes: MAX_CUPS_PDF_BYTES }); await this.#documents.verifySource(documentId); cancelled(signal); return Object.freeze({ bytes, ...evidence });
    } });
  }
  prepareExport(documentId, options) { return this.prepareRetainedArtifactExport(documentId, options); }
}
