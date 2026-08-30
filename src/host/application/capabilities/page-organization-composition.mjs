import {
  sources, service, complete, invalid, outputInvalid, pages, selectedPages,
  compositionInputs, mergeInputs, selected,
} from './page-organization-core.mjs';
import { fail, result } from './support.mjs';

export async function pagesMerge(ctx = {}) {
  const binding = await sources(ctx, { secondary: true });
  const executor = service(ctx, 'mergeDocuments');
  const [primary, secondary] = await Promise.all([
    service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal }),
    service(ctx, 'inspect').inspect(binding.secondary.id, { signal: ctx.signal }),
  ]);
  const artifact = await executor.mergeDocuments(binding.primary.id, binding.secondary.id, { signal: ctx.signal });
  return complete(ctx, binding, artifact, {
    type: 'merge-documents', inputs: mergeInputs(binding), expectedPageCount: primary.pageCount + secondary.pageCount,
    validation: ['source-sha256', 'pdfinfo-page-count'],
  }, 'pages.merge', 'source-bound-poppler-merge');
}

export async function pagesSplit(ctx = {}) {
  const binding = await sources(ctx);
  const executor = service(ctx, 'splitDocument');
  const inspection = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  if (!Number.isSafeInteger(inspection?.pageCount) || inspection.pageCount < 1 || inspection.pageCount > 100) {
    fail('PAGES_SPLIT_UNSUPPORTED', 'Split supports immutable PDFs with from 1 through 100 pages.', 422);
  }
  const artifacts = await executor.splitDocument(binding.primary.id, { signal: ctx.signal });
  if (!Array.isArray(artifacts) || artifacts.length !== inspection.pageCount) {
    outputInvalid('Split did not return one retained artifact for every source page.');
  }
  const checked = await Promise.all(artifacts.map((artifact, index) => complete(ctx, binding, artifact, {
    type: 'split-document', inputs: compositionInputs(binding), expectedPageCount: 1,
    selections: selected(binding, [index + 1]), validation: ['source-sha256', 'pdfinfo-page-count'],
  }, 'pages.split', 'source-bound-poppler-split')));
  return result('pages.split', {
    method: 'source-bound-poppler-split', sourceSha256: binding.primary.sha256,
    artifacts: checked.map(({ artifact }) => artifact), pdfArtifacts: checked.map(({ pdf }) => pdf),
    count: checked.length, pageCount: inspection.pageCount,
    semanticValidation: 'per-artifact-provenance-selection-and-reread-page-tree-v1',
  });
}

async function composeSelected(ctx, { capabilityId, type, method, selectedPages: values, payload = {} }) {
  const binding = await sources(ctx);
  const executor = service(ctx, 'arrangePages');
  const artifact = await executor.arrangePages(binding.primary.id, values, { signal: ctx.signal });
  return complete(ctx, binding, artifact, {
    type, inputs: compositionInputs(binding), expectedPageCount: values.length,
    selections: selected(binding, values), validation: ['source-sha256', 'pdfinfo-page-count'],
  }, capabilityId, method, payload);
}

export async function pagesExtract(ctx = {}) {
  const values = selectedPages(ctx, 'pageNumbers');
  const binding = await sources(ctx);
  const executor = service(ctx, 'extractPages');
  const artifact = await executor.extractPages(binding.primary.id, values, { signal: ctx.signal });
  return complete(ctx, binding, artifact, {
    type: 'extract-pages', inputs: compositionInputs(binding), expectedPageCount: values.length,
    selections: selected(binding, values), validation: ['source-sha256', 'pdfinfo-page-count'],
  }, 'pages.extract', 'source-bound-poppler-extract', { pageNumbers: values });
}

export async function pagesReorder(ctx = {}) {
  const values = pages(ctx.order, 'order');
  if (new Set(values).size !== values.length) invalid('order cannot contain a page more than once.');
  return composeSelected(ctx, {
    capabilityId: 'pages.reorder', type: 'arrange-pages', method: 'source-bound-poppler-reorder', selectedPages: values, payload: { order: values },
  });
}

export async function pagesDelete(ctx = {}) {
  const remove = pages(ctx.deletePages, 'deletePages');
  if (new Set(remove).size !== remove.length) invalid('deletePages cannot repeat a page.');
  const binding = await sources(ctx);
  const inspection = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  if (!Number.isSafeInteger(inspection?.pageCount) || inspection.pageCount < 1) outputInvalid('The source page count could not be inspected.');
  const removed = new Set(remove);
  if (remove.some((page) => page > inspection.pageCount)) invalid('deletePages is outside the source document.');
  const keep = Array.from({ length: inspection.pageCount }, (_, index) => index + 1).filter((page) => !removed.has(page));
  if (keep.length === 0) invalid('Delete must retain at least one source page.');
  const artifact = await service(ctx, 'arrangePages').arrangePages(binding.primary.id, keep, { signal: ctx.signal });
  return complete(ctx, binding, artifact, {
    type: 'arrange-pages', inputs: compositionInputs(binding), expectedPageCount: keep.length,
    selections: selected(binding, keep), validation: ['source-sha256', 'pdfinfo-page-count'],
  }, 'pages.delete', 'source-bound-poppler-delete', { deletePages: remove, keptPages: keep });
}

export async function pagesInsert(ctx = {}) {
  const binding = await sources(ctx, { secondary: true });
  const afterPage = ctx.afterPage;
  if (!Number.isSafeInteger(afterPage) || afterPage < 0) invalid('afterPage must be a non-negative page number.');
  const primary = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  const secondary = await service(ctx, 'inspect').inspect(binding.secondary.id, { signal: ctx.signal });
  if (afterPage > primary.pageCount) invalid('afterPage is outside the primary source document.');
  const artifact = await service(ctx, 'insertDocument').insertDocument(binding.primary.id, binding.secondary.id, afterPage, { signal: ctx.signal });
  const selections = [
    ...selected(binding, Array.from({ length: afterPage }, (_, i) => i + 1)),
    ...selected(binding, Array.from({ length: secondary.pageCount }, (_, i) => i + 1), true),
    ...selected(binding, Array.from({ length: primary.pageCount - afterPage }, (_, i) => afterPage + i + 1)),
  ];
  return complete(ctx, binding, artifact, {
    type: 'insert-pages', inputs: compositionInputs(binding), expectedPageCount: primary.pageCount + secondary.pageCount,
    selections, validation: ['source-sha256', 'pdfinfo-page-count'],
  }, 'pages.insert', 'source-bound-poppler-insert', { afterPage });
}

export async function pagesReplace(ctx = {}) {
  const binding = await sources(ctx, { secondary: true });
  const { startPage, endPage } = ctx;
  if (!Number.isSafeInteger(startPage) || !Number.isSafeInteger(endPage) || startPage < 1 || endPage < startPage) {
    invalid('startPage and endPage must define an ascending positive source range.');
  }
  const primary = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  const secondary = await service(ctx, 'inspect').inspect(binding.secondary.id, { signal: ctx.signal });
  if (endPage > primary.pageCount) invalid('Replacement range is outside the primary source document.');
  const artifact = await service(ctx, 'replacePages').replacePages(binding.primary.id, binding.secondary.id, startPage, endPage, { signal: ctx.signal });
  const selections = [
    ...selected(binding, Array.from({ length: startPage - 1 }, (_, i) => i + 1)),
    ...selected(binding, Array.from({ length: secondary.pageCount }, (_, i) => i + 1), true),
    ...selected(binding, Array.from({ length: primary.pageCount - endPage }, (_, i) => endPage + i + 1)),
  ];
  return complete(ctx, binding, artifact, {
    type: 'replace-pages', inputs: compositionInputs(binding), expectedPageCount: selections.length,
    selections, validation: ['source-sha256', 'pdfinfo-page-count'],
  }, 'pages.replace', 'source-bound-poppler-replace', { startPage, endPage });
}

export async function pagesDuplicate(ctx = {}) {
  const values = selectedPages(ctx, 'pageNumbers');
  if (new Set(values).size !== values.length) invalid('pageNumbers cannot repeat a page to duplicate.');
  const binding = await sources(ctx);
  const inspection = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  if (values.some((page) => page > inspection.pageCount)) invalid('pageNumbers is outside the source document.');
  const duplicate = new Set(values);
  const order = [];
  for (let page = 1; page <= inspection.pageCount; page += 1) { order.push(page); if (duplicate.has(page)) order.push(page); }
  const artifact = await service(ctx, 'duplicatePages').duplicatePages(binding.primary.id, values, { signal: ctx.signal });
  return complete(ctx, binding, artifact, {
    type: 'duplicate-pages', inputs: compositionInputs(binding), expectedPageCount: order.length,
    selections: selected(binding, order), validation: ['source-sha256', 'pdfinfo-page-count'],
  }, 'pages.duplicate', 'source-bound-poppler-duplicate', { pageNumbers: values });
}

export async function pagesCopyBetweenDocuments(ctx = {}) {
  const binding = await sources(ctx, { secondary: true });
  const sourcePage = ctx.sourcePage;
  const afterPage = ctx.afterPage;
  if (!Number.isSafeInteger(sourcePage) || sourcePage < 1 || !Number.isSafeInteger(afterPage) || afterPage < 0) {
    invalid('sourcePage and afterPage must be bounded page numbers.');
  }
  const primary = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  const secondary = await service(ctx, 'inspect').inspect(binding.secondary.id, { signal: ctx.signal });
  if (sourcePage > secondary.pageCount || afterPage > primary.pageCount) invalid('Copy-page selection is outside its immutable source.');
  const request = Object.freeze({
    profile: PDF_COPY_PAGE_PROFILE,
    primarySourceSha256: binding.primary.sha256,
    secondarySourceSha256: binding.secondary.sha256,
    sourcePage,
    afterPage,
  });
  const artifact = await service(ctx, 'copyPageBetweenDocuments').copyPageBetweenDocuments(
    binding.primary.id, binding.secondary.id, request, { signal: ctx.signal },
  );
  const selections = [
    ...selected(binding, Array.from({ length: afterPage }, (_, i) => i + 1)),
    ...selected(binding, [sourcePage], true),
    ...selected(binding, Array.from({ length: primary.pageCount - afterPage }, (_, i) => afterPage + i + 1)),
  ];
  return complete(ctx, binding, artifact, {
    type: 'copy-page-between-documents', inputs: [
      { documentId: binding.primary.id, sha256: binding.primary.sha256, role: 'primary' },
      { documentId: binding.secondary.id, sha256: binding.secondary.sha256, role: 'secondary' },
    ], expectedPageCount: selections.length,
    validation: ['source-sha256', 'poppler-page-boxes-text-render-manifest'],
    extra: (operation) => operation.parameters?.profile === PDF_COPY_PAGE_PROFILE
      && operation.parameters?.sourcePage === sourcePage
      && operation.parameters?.afterPage === afterPage
      && JSON.stringify(operation.parameters?.selections) === JSON.stringify(selections),
  }, 'pages.copy-between-documents', 'source-bound-poppler-copy-page', { sourcePage, afterPage });
}

export async function pagesReverseInterleave(ctx = {}) {
  const mode = ctx.mode;
  if (mode !== 'reverse' && mode !== 'interleave') invalid('mode must be reverse or interleave.');
  const binding = await sources(ctx, { secondary: mode === 'interleave' });
  const primary = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  if (mode === 'reverse') {
    const order = Array.from({ length: primary.pageCount }, (_, index) => primary.pageCount - index);
    const artifact = await service(ctx, 'reversePages').reversePages(binding.primary.id, { signal: ctx.signal });
    return complete(ctx, binding, artifact, {
      type: 'reverse-pages', inputs: compositionInputs(binding), expectedPageCount: order.length,
      selections: selected(binding, order), validation: ['source-sha256', 'pdfinfo-page-count'],
    }, 'pages.reverse-interleave', 'source-bound-poppler-reverse', { mode });
  }
  const secondary = await service(ctx, 'inspect').inspect(binding.secondary.id, { signal: ctx.signal });
  const order = [];
  for (let page = 1; page <= Math.max(primary.pageCount, secondary.pageCount); page += 1) {
    if (page <= primary.pageCount) order.push({ input: 0, page });
    if (page <= secondary.pageCount) order.push({ input: 1, page });
  }
  const artifact = await service(ctx, 'interleaveDocuments').interleaveDocuments(binding.primary.id, binding.secondary.id, { signal: ctx.signal });
  return complete(ctx, binding, artifact, {
    type: 'interleave-documents', inputs: compositionInputs(binding), expectedPageCount: order.length,
    selections: order, validation: ['source-sha256', 'pdfinfo-page-count'],
  }, 'pages.reverse-interleave', 'source-bound-poppler-interleave', { mode });
}

export async function pagesSplitByRule(ctx = {}) {
  const everyN = ctx.everyN ?? ctx.pagesPerOutput;
  if (!Number.isSafeInteger(everyN) || everyN < 1 || everyN > 500) invalid('everyN must be an integer from 1 through 500.');
  const binding = await sources(ctx);
  const inspection = await service(ctx, 'inspect').inspect(binding.primary.id, { signal: ctx.signal });
  if (ctx.signal?.aborted) fail('JOB_CANCELLED', 'The page organization request was cancelled.', 499);
  if (!Number.isSafeInteger(inspection?.pageCount) || inspection.pageCount < 1) outputInvalid('The source page count could not be inspected.');
  const outputCount = Math.ceil(inspection.pageCount / everyN);
  const artifacts = await service(ctx, 'splitByPageCount').splitByPageCount(binding.primary.id, everyN, { signal: ctx.signal });
  if (!Number.isSafeInteger(outputCount) || outputCount < 1) {
    outputInvalid('Rule split did not return the expected artifact count.');
  }
  if (ctx.signal?.aborted) {
    fail('JOB_CANCELLED', 'The page organization request was cancelled.', 499);
  }
  if (!Array.isArray(artifacts) || artifacts.length !== outputCount) outputInvalid('Rule split did not return the expected artifact count.');
  const artifactIds = new Set();
  const checked = [];
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (!artifact || typeof artifact.id !== 'string' || artifact.id.length < 1 || artifactIds.has(artifact.id)) {
      outputInvalid('Rule split returned an invalid retained artifact.');
    }
    artifactIds.add(artifact.id);
    if (ctx.signal?.aborted) fail('JOB_CANCELLED', 'The page organization request was cancelled.', 499);
    const first = index * everyN + 1;
    const count = Math.min(everyN, inspection.pageCount - first + 1);
    checked.push(await complete(ctx, binding, artifact, {
      type: 'split-by-page-count', inputs: compositionInputs(binding), expectedPageCount: count,
      selections: selected(binding, Array.from({ length: count }, (_, i) => first + i)),
      validation: ['source-sha256', 'pdfinfo-page-count'],
      extra: (operation) => operation.parameters?.splitRule?.kind === 'every-pages'
        && operation.parameters.splitRule.pagesPerOutput === everyN
        && operation.parameters.splitRule.outputIndex === index + 1
        && operation.parameters.splitRule.outputCount === outputCount,
    }, 'pages.split-by-rule', 'source-bound-poppler-page-count-split'));
  }
  if (ctx.signal?.aborted) fail('JOB_CANCELLED', 'The page organization request was cancelled.', 499);
  return result('pages.split-by-rule', {
    method: 'source-bound-poppler-page-count-split', sourceSha256: binding.primary.sha256,
    everyN, artifacts: checked.map(({ artifact }) => artifact), pdfArtifacts: checked.map(({ pdf }) => pdf),
    parts: checked.length, semanticValidation: 'per-artifact-provenance-selection-and-reread-page-tree-v1',
  });
}
