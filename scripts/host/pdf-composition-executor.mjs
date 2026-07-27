import {
  createDeadline,
  createWorkspaceQuotaMonitor,
  mapEngineError,
  MAX_COMPOSE_JOB_MS,
  MAX_COMPOSE_SOURCES,
  MAX_MERGE_JOB_MS,
  validateSelections,
} from './pdf-service-foundation.mjs';
import { basename, extname, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { stagePrivateSourceCopy, assertPrivateSourceCopy } from './private-source-copy.mjs';
import {
  PDF_COPY_PAGE_VALIDATORS,
  validateCopyPageRequest,
} from './pdf-copy-page-contract.mjs';
import { isDeepStrictEqual } from 'node:util';
import { parsePdfInfo } from './pdf-service-foundation.mjs';

const COPY_MAX_BYTES = 64 * 1024 * 1024;

export class PdfCompositionExecutor {
  #store; #adapter; #validation;

  constructor({ store, adapter, validation }) {
    this.#store = store;
    this.#adapter = adapter;
    this.#validation = validation;
  }

  async composePages(primaryDocumentId, selections, {
    operationType = 'compose-pages', fileLabel = 'composed', parameters = {}, signal: externalSignal,
  } = {}) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(operationType)) {
      throw new HostError('INVALID_OPERATION', 'The composition operation type is invalid.', 400);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(fileLabel)) {
      throw new HostError('INVALID_OPERATION', 'The composition file label is invalid.', 400);
    }
    const selected = validateSelections(selections);
    const deadline = createDeadline(externalSignal, MAX_COMPOSE_JOB_MS);
    let workspace = null;
    let quota = null;
    try {
      const sourceIds = [...new Set([primaryDocumentId, ...selected.map(({ documentId }) => documentId)])];
      if (sourceIds.length > MAX_COMPOSE_SOURCES) {
        throw new HostError('COMPOSE_SOURCE_LIMIT', `A composition may use at most ${MAX_COMPOSE_SOURCES} source PDFs.`, 422);
      }
      const sources = new Map(sourceIds.map((documentId) => [documentId, this.#store.getDocument(documentId)]));
      const inspections = await this.#validation.inspectSources(sourceIds, { signal: deadline.signal });
      this.#validation.validateSelections(selected, inspections);
      await this.#validation.verifySources(sourceIds);
      workspace = await this.#store.createJobWorkspace(primaryDocumentId);
      quota = createWorkspaceQuotaMonitor(workspace, deadline);
      const pageFiles = [];
      for (const [index, selection] of selected.entries()) {
        const input = this.#store.getSourcePath(selection.documentId);
        const outputPattern = join(workspace, `selection-${index}-%d.pdf`);
        await this.#adapter.execute('splitPages', {
          input, outputPattern, firstPage: selection.page, lastPage: selection.page,
        }, {
          cwd: workspace, signal: deadline.signal, timeoutMs: 30_000,
          maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024,
        });
        pageFiles.push(join(workspace, `selection-${index}-${selection.page}.pdf`));
        await quota.check();
      }
      const combinedPath = pageFiles.length === 1 ? pageFiles[0] : join(workspace, 'extracted.pdf');
      if (pageFiles.length > 1) {
        await this.#adapter.execute('mergeDocuments', { inputs: pageFiles, output: combinedPath }, {
          cwd: workspace, signal: deadline.signal, timeoutMs: 45_000,
          maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024,
        });
        await quota.check();
      }
      const derivedInspection = await this.#validation.validateDerivedPdf(combinedPath, {
        expectedPageCount: selected.length, signal: deadline.signal,
      });
      await Promise.all(pageFiles.filter((filePath) => filePath !== combinedPath)
        .map((filePath) => unlink(filePath).catch(() => {})));
      await quota.check();
      await this.#validation.verifySources(sourceIds);
      const primary = sources.get(primaryDocumentId);
      const stem = basename(primary.displayName, extname(primary.displayName));
      const sourceIndex = new Map(sourceIds.map((documentId, index) => [documentId, index]));
      const expectedSha256 = await this.#validation.digestOutput(combinedPath);
      return await this.#store.promotePdfArtifact(primaryDocumentId, combinedPath, {
        displayName: `${stem}-${fileLabel}.pdf`, expectedSha256, signal: deadline.signal,
        operation: createOperationProvenance({
          type: operationType,
          inputs: sourceIds.map((documentId, index) => ({
            documentId, sha256: sources.get(documentId).sha256, role: index === 0 ? 'primary' : `source-${index}`,
          })),
          parameters: {
            selections: selected.map(({ documentId, page }) => ({ input: sourceIndex.get(documentId), page })), ...parameters,
          },
          expected: { pageCount: selected.length },
          validation: { passed: true, validators: ['source-sha256', 'pdfinfo-page-count'], pageCount: derivedInspection.pageCount },
        }),
      });
    } catch (error) {
      if (quota?.error) throw quota.error;
      if (deadline.timedOut) throw new HostError('COMPOSE_JOB_TIMEOUT', 'The derived-page operation exceeded its five-minute deadline.', 504, { cause: error });
      if (externalSignal?.aborted) throw new HostError('JOB_CANCELLED', 'The derived-page operation was cancelled.', 499, { cause: error });
      throw mapEngineError(error);
    } finally {
      quota?.stop();
      deadline.dispose();
      if (workspace) await this.#store.cleanupJob(workspace);
    }
  }

  async mergeDocuments(primaryDocumentId, secondaryDocumentId, { signal: externalSignal } = {}) {
    if (primaryDocumentId === secondaryDocumentId) throw new HostError('INVALID_MERGE', 'Choose a different PDF to merge.', 400);
    const deadline = createDeadline(externalSignal, MAX_MERGE_JOB_MS);
    let workspace = null;
    let quota = null;
    try {
      const primary = this.#store.getDocument(primaryDocumentId);
      const secondary = this.#store.getDocument(secondaryDocumentId);
      const primaryPath = this.#store.getSourcePath(primaryDocumentId);
      const secondaryPath = this.#store.getSourcePath(secondaryDocumentId);
      const [primaryInspection, secondaryInspection] = await Promise.all([
        this.#validation.inspectSources([primaryDocumentId], { signal: deadline.signal }).then((items) => items.get(primaryDocumentId)),
        this.#validation.inspectSources([secondaryDocumentId], { signal: deadline.signal }).then((items) => items.get(secondaryDocumentId)),
      ]);
      workspace = await this.#store.createJobWorkspace(primaryDocumentId);
      quota = createWorkspaceQuotaMonitor(workspace, deadline);
      const output = join(workspace, 'merged.pdf');
      await this.#validation.verifySources([primaryDocumentId, secondaryDocumentId]);
      await this.#adapter.execute('mergeDocuments', { inputs: [primaryPath, secondaryPath], output }, {
        cwd: workspace, signal: deadline.signal, timeoutMs: 60_000,
        maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024,
      });
      await quota.check();
      await this.#validation.verifySources([secondaryDocumentId]);
      const expectedPageCount = primaryInspection.pageCount + secondaryInspection.pageCount;
      const derivedInspection = await this.#validation.validateDerivedPdf(output, { expectedPageCount, signal: deadline.signal });
      const stem = basename(primary.displayName, extname(primary.displayName));
      const expectedSha256 = await this.#validation.digestOutput(output);
      return await this.#store.promotePdfArtifact(primaryDocumentId, output, {
        displayName: `${stem}-merged.pdf`, expectedSha256, signal: deadline.signal,
        operation: createOperationProvenance({
          type: 'merge-documents',
          inputs: [
            { documentId: primaryDocumentId, sha256: primary.sha256, role: 'primary' },
            { documentId: secondaryDocumentId, sha256: secondary.sha256, role: 'secondary' },
          ],
          parameters: {}, expected: { pageCount: expectedPageCount },
          validation: { passed: true, validators: ['source-sha256', 'pdfinfo-page-count'], pageCount: derivedInspection.pageCount },
        }),
      });
    } catch (error) {
      if (quota?.error) throw quota.error;
      if (deadline.timedOut) throw new HostError('MERGE_JOB_TIMEOUT', 'The merge operation exceeded its two-minute deadline.', 504, { cause: error });
      if (externalSignal?.aborted) throw new HostError('JOB_CANCELLED', 'The merge operation was cancelled.', 499, { cause: error });
      throw mapEngineError(error);
    } finally {
      quota?.stop();
      deadline.dispose();
      if (workspace) await this.#store.cleanupJob(workspace);
    }
  }

  async copyPageBetweenDocuments(primaryDocumentId, secondaryDocumentId, request, { signal: externalSignal } = {}) {
    if (primaryDocumentId === secondaryDocumentId) throw new HostError('INVALID_COPY_PAGE', 'Choose distinct primary and secondary PDFs.', 400);
    const deadline = createDeadline(externalSignal, MAX_COMPOSE_JOB_MS); let workspace = null; let quota = null;
    try {
      const primarySource = this.#store.getDocument(primaryDocumentId); const secondarySource = this.#store.getDocument(secondaryDocumentId);
      if (primarySource.size > COPY_MAX_BYTES || secondarySource.size > COPY_MAX_BYTES || primarySource.size < 1 || secondarySource.size < 1) throw new HostError('COPY_PAGE_INPUT_TOO_LARGE', 'Copy-page inputs must be non-empty PDFs no larger than 64 MiB.', 413);
      await this.#validation.verifySources([primaryDocumentId, secondaryDocumentId]);
      workspace = await this.#store.createJobWorkspace(primaryDocumentId); quota = createWorkspaceQuotaMonitor(workspace, deadline);
      const primaryPath = join(workspace, 'primary-source.pdf'); const secondaryPath = join(workspace, 'secondary-source.pdf');
      const [primaryIdentity, secondaryIdentity] = await Promise.all([
        stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(primaryDocumentId), targetPath: primaryPath, expectedSha256: primarySource.sha256, expectedSize: primarySource.size, maximumBytes: COPY_MAX_BYTES, signal: deadline.signal }),
        stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(secondaryDocumentId), targetPath: secondaryPath, expectedSha256: secondarySource.sha256, expectedSize: secondarySource.size, maximumBytes: COPY_MAX_BYTES, signal: deadline.signal }),
      ]);
      const [primaryResult, secondaryResult] = await Promise.all([
        this.#adapter.execute('inspect', { input: primaryPath }, { cwd: workspace, signal: deadline.signal, timeoutMs: 20_000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024 }),
        this.#adapter.execute('inspect', { input: secondaryPath }, { cwd: workspace, signal: deadline.signal, timeoutMs: 20_000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024 }),
      ]);
      if (String(primaryResult.stderr ?? '').trim() || String(secondaryResult.stderr ?? '').trim()) throw new HostError('POPPLER_WARNING', 'Poppler reported a warning while admitting copy-page sources.', 422);
      const primaryInfo = parsePdfInfo(primaryResult.stdout); const secondaryInfo = parsePdfInfo(secondaryResult.stdout);
      if (primaryInfo.pageCount < 1 || primaryInfo.pageCount > 100 || secondaryInfo.pageCount < 1 || secondaryInfo.pageCount > 100) throw new HostError('COPY_PAGE_PAGE_LIMIT', 'Copy-page inputs must contain from 1 through 100 pages.', 422);
      await Promise.all([this.#validation.assertPassiveCopySource(primaryPath, primaryInfo, workspace, { signal: deadline.signal }), this.#validation.assertPassiveCopySource(secondaryPath, secondaryInfo, workspace, { signal: deadline.signal })]);
      const requestChecked = validateCopyPageRequest(request, { ...primarySource, pageCount: primaryInfo.pageCount }, { ...secondarySource, pageCount: secondaryInfo.pageCount });
      const selections = []; for (let page = 1; page <= requestChecked.afterPage; page += 1) selections.push({ role: 'primary', page }); selections.push({ role: 'secondary', page: requestChecked.sourcePage }); for (let page = requestChecked.afterPage + 1; page <= primaryInfo.pageCount; page += 1) selections.push({ role: 'primary', page });
      const expectedPages = [];
      const manifests = await Promise.all([this.#validation.semanticManifest(primaryPath, primaryInfo.pageCount, workspace, { signal: deadline.signal, prefix: 'primary-proof' }), this.#validation.semanticManifest(secondaryPath, secondaryInfo.pageCount, workspace, { signal: deadline.signal, prefix: 'secondary-proof' })]);
      for (const selection of selections) expectedPages.push((selection.role === 'primary' ? manifests[0] : manifests[1]).pages[selection.page - 1]);
      const pageFiles = [];
      for (const [index, selection] of selections.entries()) { const input = selection.role === 'primary' ? primaryPath : secondaryPath; const outputPattern = join(workspace, `copy-${index}-%d.pdf`); await this.#adapter.execute('splitPages', { input, outputPattern, firstPage: selection.page, lastPage: selection.page }, { cwd: workspace, signal: deadline.signal, timeoutMs: 30_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024 }); pageFiles.push(join(workspace, `copy-${index}-${selection.page}.pdf`)); await quota.check(); }
      const output = join(workspace, 'copied.pdf'); await this.#adapter.execute('mergeDocuments', { inputs: pageFiles, output }, { cwd: workspace, signal: deadline.signal, timeoutMs: 45_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 128 * 1024 }); await quota.check();
      const outputManifest = await this.#validation.semanticManifest(output, selections.length, workspace, { signal: deadline.signal, prefix: 'output-proof' });
      if (!isDeepStrictEqual(outputManifest.pages, expectedPages)) throw new HostError('COPY_PAGE_MANIFEST_MISMATCH', 'The copied PDF page manifest does not match the requested source-page order.', 502);
      await Promise.all([assertPrivateSourceCopy({ path: primaryPath, identity: primaryIdentity, expectedSha256: primarySource.sha256, expectedSize: primarySource.size, maximumBytes: COPY_MAX_BYTES }), assertPrivateSourceCopy({ path: secondaryPath, identity: secondaryIdentity, expectedSha256: secondarySource.sha256, expectedSize: secondarySource.size, maximumBytes: COPY_MAX_BYTES })]); await this.#validation.verifySources([primaryDocumentId, secondaryDocumentId]);
      const expectedSha256 = await this.#validation.digestOutput(output); const stem = basename(primarySource.displayName, extname(primarySource.displayName));
      return await this.#store.promotePdfArtifact(primaryDocumentId, output, { displayName: `${stem}-page-copied.pdf`, expectedSha256, signal: deadline.signal, operation: createOperationProvenance({ type: 'copy-page-between-documents', inputs: [{ documentId: primaryDocumentId, sha256: primarySource.sha256, role: 'primary' }, { documentId: secondaryDocumentId, sha256: secondarySource.sha256, role: 'secondary' }], parameters: { profile: requestChecked.profile, sourcePage: requestChecked.sourcePage, afterPage: requestChecked.afterPage, selections: selections.map(({ role, page }) => ({ input: role === 'primary' ? 0 : 1, page })) }, expected: { pageCount: selections.length, manifestSha256: outputManifest.sha256 }, validation: { passed: true, validators: PDF_COPY_PAGE_VALIDATORS, pageCount: selections.length, manifestSha256: outputManifest.sha256 } }) });
    } catch (error) { if (quota?.error) throw quota.error; if (deadline.timedOut) throw new HostError('COMPOSE_JOB_TIMEOUT', 'The copy-page operation exceeded its five-minute deadline.', 504, { cause: error }); if (externalSignal?.aborted) throw new HostError('JOB_CANCELLED', 'The copy-page operation was cancelled.', 499, { cause: error }); throw mapEngineError(error); } finally { quota?.stop(); deadline.dispose(); if (workspace) await this.#store.cleanupJob(workspace); }
  }
}
