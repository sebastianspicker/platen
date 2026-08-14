import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import { normalizeSnapshotRegion } from './snapshot-output.js';

const jsonOptions = (body, signal) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
const documentPath = (documentId, suffix) => `/api/documents/${encodeURIComponent(documentId)}${suffix}`;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_FIELDS = Object.freeze(['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt']);
const OPERATION_FIELDS = Object.freeze(['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt']);
const VALIDATORS = Object.freeze(['source-sha256', 'pdfinfo-page-count', 'semantic-page-manifest']);

function invalidCompositionResponse() {
  throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound page-composition receipt.');
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function exactOptions(options) {
  const keys = options?.signal === undefined ? [] : ['signal'];
  return exactObject(options, keys)
    && (options.signal === undefined || options.signal instanceof AbortSignal);
}

function validSource(documentId, sourceSha256) {
  return OPAQUE_ID_PATTERN.test(documentId ?? '') && SHA256_PATTERN.test(sourceSha256 ?? '');
}

function validPages(pages) {
  return Array.isArray(pages) && pages.length >= 1 && pages.length <= 500
    && pages.every((page) => Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000)
    && new Set(pages).size === pages.length;
}

function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function sequentialSelections(selections, input, firstPage, lastPage) {
  const expected = Array.from({ length: Math.max(0, lastPage - firstPage + 1) }, (_, index) => ({ input, page: firstPage + index }));
  return sameJson(selections, expected);
}

function validSelections(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 1_000
    && value.every((selection) => exactObject(selection, ['input', 'page'])
      && (selection.input === 0 || selection.input === 1)
      && Number.isSafeInteger(selection.page) && selection.page >= 1 && selection.page <= 1_000_000);
}

function expectedInputs(context) {
  return context.secondaryDocumentId ? [
    { documentId: context.documentId, sha256: context.sourceSha256, role: 'primary' },
    { documentId: context.secondaryDocumentId, sha256: context.secondarySourceSha256, role: context.type === 'merge-documents' ? 'secondary' : 'source-1' },
  ] : [{ documentId: context.documentId, sha256: context.sourceSha256, role: 'primary' }];
}

function validCompositionSemantics(operation, context) {
  const selections = operation.parameters.selections;
  const count = operation.expected.pageCount;
  if (context.type === 'merge-documents') return exactObject(operation.parameters, []);
  if (!validSelections(selections) || selections.length !== count) return false;
  if (context.type === 'split-document') return exactObject(operation.parameters, ['selections']);
  if (context.type === 'split-by-page-count') return exactObject(operation.parameters, ['selections', 'splitRule']);
  if (context.type === 'extract-pages' || context.type === 'arrange-pages') {
    if (!exactObject(operation.parameters, ['selections'])) return false;
    if (context.deletedPages) {
      const kept = selections.map(({ page }) => page);
      const sourcePages = [...kept, ...context.deletedPages].sort((a, b) => a - b);
      return selections.every(({ input }) => input === 0)
        && kept.every((page, index) => index === 0 || kept[index - 1] < page)
        && sourcePages.every((page, index) => page === index + 1);
    }
    return sameJson(selections, context.pages.map((page) => ({ input: 0, page })));
  }
  if (context.type === 'duplicate-pages') {
    if (!exactObject(operation.parameters, ['selections'])) return false;
    const sourceCount = count - context.pages.length;
    const duplicates = new Set(context.pages); const expected = [];
    for (let page = 1; page <= sourceCount; page += 1) { expected.push({ input: 0, page }); if (duplicates.has(page)) expected.push({ input: 0, page }); }
    return sourceCount >= 1 && context.pages.every((page) => page <= sourceCount) && sameJson(selections, expected);
  }
  if (context.type === 'reverse-pages') {
    if (!exactObject(operation.parameters, ['selections'])) return false;
    return sameJson(selections, Array.from({ length: count }, (_, index) => ({ input: 0, page: count - index })));
  }
  if (context.type === 'interleave-documents') {
    if (!exactObject(operation.parameters, ['selections'])) return false;
    const pageCounts = [0, 0];
    for (const selection of selections) pageCounts[selection.input] = Math.max(pageCounts[selection.input], selection.page);
    if (pageCounts.some((value) => value < 1)) return false;
    const expected = [];
    for (let page = 1; page <= Math.max(...pageCounts); page += 1) {
      if (page <= pageCounts[0]) expected.push({ input: 0, page });
      if (page <= pageCounts[1]) expected.push({ input: 1, page });
    }
    return sameJson(selections, expected);
  }
  if (context.type === 'insert-pages') {
    if (!exactObject(operation.parameters, ['selections'])) return false;
    const firstSecondary = selections.findIndex(({ input }) => input === 1);
    const lastSecondary = selections.findLastIndex(({ input }) => input === 1);
    return firstSecondary === context.afterPage && firstSecondary >= 0
      && sequentialSelections(selections.slice(0, firstSecondary), 0, 1, context.afterPage)
      && sequentialSelections(selections.slice(firstSecondary, lastSecondary + 1), 1, 1, lastSecondary - firstSecondary + 1)
      && selections.slice(lastSecondary + 1).every((entry, index) => entry.input === 0 && entry.page === context.afterPage + index + 1);
  }
  if (context.type === 'replace-pages') {
    if (!exactObject(operation.parameters, ['selections'])) return false;
    const firstSecondary = selections.findIndex(({ input }) => input === 1);
    const lastSecondary = selections.findLastIndex(({ input }) => input === 1);
    return firstSecondary === context.startPage - 1 && firstSecondary >= 0
      && sequentialSelections(selections.slice(0, firstSecondary), 0, 1, context.startPage - 1)
      && sequentialSelections(selections.slice(firstSecondary, lastSecondary + 1), 1, 1, lastSecondary - firstSecondary + 1)
      && selections.slice(lastSecondary + 1).every((entry, index) => entry.input === 0 && entry.page === context.endPage + index + 1);
  }
  return false;
}

function validArtifact(artifact, context) {
  if (!exactObject(artifact, ARTIFACT_FIELDS) || !OPAQUE_ID_PATTERN.test(artifact.id ?? '')
    || artifact.documentId !== context.documentId || typeof artifact.displayName !== 'string'
    || artifact.displayName.length < 1 || artifact.displayName.length > 240
    || /[\u0000-\u001f\u007f]/.test(artifact.displayName) || artifact.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(artifact.size) || artifact.size < 64 || artifact.size > 512 * 1024 * 1024
    || !SHA256_PATTERN.test(artifact.sha256 ?? '') || !canonicalTimestamp(artifact.createdAt)) return false;
  const operation = artifact.operation;
  if (!exactObject(operation, OPERATION_FIELDS) || operation.schemaVersion !== 1
    || !OPAQUE_ID_PATTERN.test(operation.id ?? '') || operation.type !== context.type
    || !canonicalTimestamp(operation.completedAt) || !sameJson(operation.inputs, expectedInputs(context))
    || !exactObject(operation.expected, ['pageCount', 'manifestSha256'])
    || !Number.isSafeInteger(operation.expected.pageCount) || operation.expected.pageCount < 1 || operation.expected.pageCount > 1_000
    || !SHA256_PATTERN.test(operation.expected.manifestSha256 ?? '')
    || !exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'manifestSha256'])
    || operation.validation.passed !== true || !sameJson(operation.validation.validators, VALIDATORS)
    || operation.validation.pageCount !== operation.expected.pageCount
    || operation.validation.manifestSha256 !== operation.expected.manifestSha256
    || !validCompositionSemantics(operation, context)) return false;
  return true;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateArtifactBody(body, context) {
  if (!exactObject(body, ['artifact']) || !validArtifact(body.artifact, context)) invalidCompositionResponse();
  return deepFreeze(body.artifact);
}

function validSplitArtifact(artifact, context, index, count) {
  if (!validArtifact(artifact, context)) return false;
  const { operation } = artifact;
  if (context.type === 'split-document') {
    return exactObject(operation.parameters, ['selections'])
      && sameJson(operation.parameters.selections, [{ input: 0, page: index + 1 }]);
  }
  const { splitRule, selections } = operation.parameters;
  const firstPage = index * context.pagesPerOutput + 1;
  return exactObject(operation.parameters, ['selections', 'splitRule'])
    && exactObject(splitRule, ['kind', 'pagesPerOutput', 'outputIndex', 'outputCount'])
    && splitRule.kind === 'every-pages' && splitRule.pagesPerOutput === context.pagesPerOutput
    && splitRule.outputIndex === index + 1 && splitRule.outputCount === count
    && selections.length <= context.pagesPerOutput
    && sequentialSelections(selections, 0, firstPage, firstPage + selections.length - 1);
}

function validateArtifactsBody(body, context) {
  if (!exactObject(body, ['artifacts']) || !Array.isArray(body.artifacts)
    || body.artifacts.length < 1 || body.artifacts.length > 100
    || new Set(body.artifacts.map((artifact) => artifact?.id)).size !== body.artifacts.length
    || body.artifacts.some((artifact, index) => !validSplitArtifact(artifact, context, index, body.artifacts.length))) invalidCompositionResponse();
  return deepFreeze(body.artifacts);
}

function assertOneSource(documentId, sourceSha256, options) {
  if (!validSource(documentId, sourceSha256) || !exactOptions(options)) throw new TypeError('Page-composition options are invalid.');
}

function assertTwoSources(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, options) {
  if (!validSource(documentId, sourceSha256) || !validSource(secondaryDocumentId, secondarySourceSha256)
    || documentId === secondaryDocumentId || !exactOptions(options)) throw new TypeError('Page-composition options are invalid.');
}

/** Document, workspace, composition, and ephemeral-resource endpoints. */
export function createDocumentEndpoints({ json, blob, request }) {
  return {
    async upload(file, { signal } = {}) {
      if (!file) throw new TypeError('upload requires a File or Blob.');
      return json('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Document-Name': encodeURIComponent(file.name || 'local-document.pdf') }, body: file, signal }).then((body) => body.document);
    },
    async uploadInput(file, { signal } = {}) {
      if (!file) throw new TypeError('uploadInput requires a File or Blob.');
      return json('/api/inputs', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Document-Name': encodeURIComponent(file.name || 'local-input.bin') }, body: file, signal }).then((body) => body.input);
    },
    createBlank(options = {}, { signal } = {}) { return json('/api/documents/create-blank', jsonOptions(options, signal)).then((body) => body.document); },
    createText(options = {}, { signal } = {}) { return json('/api/documents/create-text', jsonOptions(options, signal)).then((body) => body.document); },
    convertInput(inputId, { signal } = {}) { return json(`/api/inputs/${encodeURIComponent(inputId)}/convert`, { method: 'POST', signal }).then((body) => body.document); },
    inspect(documentId, { signal } = {}) { return json(documentPath(documentId, '/inspection'), { signal }).then((body) => body.inspection); },
    inspectStructure(documentId, { firstPage = 1, lastPage = null, includeTagText = false, signal } = {}) {
      if (!Number.isSafeInteger(firstPage) || firstPage < 1) throw new TypeError('firstPage must be a positive integer.');
      if (lastPage !== null && (!Number.isSafeInteger(lastPage) || lastPage < firstPage)) throw new TypeError('lastPage must be null or an integer at least firstPage.');
      if (typeof includeTagText !== 'boolean') throw new TypeError('includeTagText must be a boolean.');
      const query = new URLSearchParams({ first: String(firstPage), includeTagText: String(includeTagText) }); if (lastPage !== null) query.set('last', String(lastPage));
      return json(documentPath(documentId, `/structure?${query}`), { signal }).then((body) => body.structure);
    },
    workspace(documentId, { signal } = {}) { return json(documentPath(documentId, '/workspace'), { signal }).then((body) => body.workspace); },
    mutateWorkspace(documentId, mutation, { signal } = {}) { return json(documentPath(documentId, '/workspace'), jsonOptions(mutation, signal)).then((body) => body.workspace); },
    replaceWorkspace(documentId, snapshot, expectedRevision, { signal } = {}) { return json(documentPath(documentId, '/workspace'), { ...jsonOptions({ snapshot, expectedRevision }, signal), method: 'PUT' }).then((body) => body.workspace); },
    text(documentId, pageCount, { signal } = {}) { return json(documentPath(documentId, `/text${Number.isInteger(pageCount) ? `?pages=${pageCount}` : ''}`), { signal }).then((body) => body.pages); },
    fonts(documentId, { signal } = {}) { return json(documentPath(documentId, '/fonts'), { signal }).then((body) => body.fonts); },
    images(documentId, { signal } = {}) { return json(documentPath(documentId, '/images'), { signal }).then((body) => body.images); },
    attachments(documentId, { signal } = {}) { return json(documentPath(documentId, '/attachments'), { signal }).then((body) => body.attachments); },
    signatures(documentId, { signal } = {}) { return json(documentPath(documentId, '/signatures'), { signal }).then((body) => body.signatures); },
    ocrLanguages({ signal } = {}) { return json('/api/ocr/languages', { signal }).then((body) => body.languages); },
    domainOperations({ signal } = {}) { return json('/api/domains', { signal }).then((body) => body.operations); },
    executeDomain(documentId, group, operation, body = {}, { signal } = {}) { return json(documentPath(documentId, '/domain'), jsonOptions({ group, operation, body }, signal)).then((responseBody) => responseBody.result); },
    thumbnail(documentId, page, dpi = 96, { signal } = {}) { return blob(documentPath(documentId, `/thumbnail?page=${page}&dpi=${dpi}`), { signal }); },
    cropBoxRaster(documentId, page, dpi = 192, { signal } = {}) {
      if (typeof documentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(documentId)) throw new TypeError('documentId must be an opaque local identifier.');
      if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new TypeError('page must be a positive bounded integer.');
      if (!Number.isSafeInteger(dpi) || dpi < 36 || dpi > 240) throw new TypeError('dpi must be an integer from 36 through 240.');
      return blob(documentPath(documentId, `/cropbox-raster?page=${page}&dpi=${dpi}`), { signal });
    },
    cropBoxSnapshot(documentId, page, region, dpi = 192, { signal } = {}) {
      if (typeof documentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(documentId)) throw new TypeError('documentId must be an opaque local identifier.');
      if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new TypeError('page must be a positive bounded integer.');
      if (!Number.isSafeInteger(dpi) || dpi < 36 || dpi > 240) throw new TypeError('dpi must be an integer from 36 through 240.');
      const normalized = normalizeSnapshotRegion(region); const query = new URLSearchParams({ page: String(page), dpi: String(dpi), x: String(normalized.x), y: String(normalized.y), width: String(normalized.width), height: String(normalized.height) });
      return blob(documentPath(documentId, `/cropbox-snapshot?${query}`), { signal });
    },
    extractPages(documentId, sourceSha256, pages, options = {}) {
      assertOneSource(documentId, sourceSha256, options); if (!validPages(pages)) throw new TypeError('Pages are invalid.');
      const context = { documentId, sourceSha256, pages, type: 'extract-pages' };
      return json(documentPath(documentId, '/extract'), jsonOptions({ sourceSha256, pages }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    arrangePages(documentId, sourceSha256, pages, options = {}) {
      assertOneSource(documentId, sourceSha256, options); if (!validPages(pages)) throw new TypeError('Pages are invalid.');
      const context = { documentId, sourceSha256, pages, type: 'arrange-pages' };
      return json(documentPath(documentId, '/arrange'), jsonOptions({ sourceSha256, pages }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    deletePages(documentId, sourceSha256, pages, options = {}) {
      assertOneSource(documentId, sourceSha256, options); if (!validPages(pages)) throw new TypeError('Pages are invalid.');
      const context = { documentId, sourceSha256, deletedPages: pages, type: 'arrange-pages' };
      return json(documentPath(documentId, '/delete'), jsonOptions({ sourceSha256, pages }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    mergeDocuments(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, options = {}) {
      assertTwoSources(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, options);
      const context = { documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, type: 'merge-documents' };
      return json(documentPath(documentId, '/merge'), jsonOptions({ primarySourceSha256: sourceSha256, secondaryDocumentId, secondarySourceSha256 }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    splitDocument(documentId, sourceSha256, options = {}) {
      assertOneSource(documentId, sourceSha256, options); const context = { documentId, sourceSha256, type: 'split-document' };
      return json(documentPath(documentId, '/split'), jsonOptions({ sourceSha256 }, options.signal)).then((body) => validateArtifactsBody(body, context));
    },
    splitByPageCount(documentId, sourceSha256, pagesPerOutput, options = {}) {
      assertOneSource(documentId, sourceSha256, options);
      if (!Number.isSafeInteger(pagesPerOutput) || pagesPerOutput < 1 || pagesPerOutput > 500) throw new TypeError('pagesPerOutput is invalid.');
      const context = { documentId, sourceSha256, pagesPerOutput, type: 'split-by-page-count' };
      return json(documentPath(documentId, '/split-rule'), jsonOptions({ sourceSha256, pagesPerOutput }, options.signal)).then((body) => validateArtifactsBody(body, context));
    },
    splitByVerifiedTopLevelOutline(documentId, { signal } = {}) { return json(documentPath(documentId, '/split-outline'), jsonOptions({ profile: 'macos-pdfkit-top-level-outline-split-v1' }, signal)).then((body) => body.artifacts); },
    duplicatePages(documentId, sourceSha256, pages, options = {}) {
      assertOneSource(documentId, sourceSha256, options); if (!validPages(pages)) throw new TypeError('Pages are invalid.');
      const context = { documentId, sourceSha256, pages, type: 'duplicate-pages' };
      return json(documentPath(documentId, '/duplicate'), jsonOptions({ sourceSha256, pages }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    reversePages(documentId, sourceSha256, options = {}) {
      assertOneSource(documentId, sourceSha256, options); const context = { documentId, sourceSha256, type: 'reverse-pages' };
      return json(documentPath(documentId, '/reverse'), jsonOptions({ sourceSha256 }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    interleaveDocuments(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, options = {}) {
      assertTwoSources(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, options);
      const context = { documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, type: 'interleave-documents' };
      return json(documentPath(documentId, '/interleave'), jsonOptions({ primarySourceSha256: sourceSha256, secondaryDocumentId, secondarySourceSha256 }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    insertDocument(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, afterPage, options = {}) {
      assertTwoSources(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, options);
      if (!Number.isSafeInteger(afterPage) || afterPage < 0 || afterPage > 1_000_000) throw new TypeError('afterPage is invalid.');
      const context = { documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, afterPage, type: 'insert-pages' };
      return json(documentPath(documentId, '/insert'), jsonOptions({ primarySourceSha256: sourceSha256, secondaryDocumentId, secondarySourceSha256, afterPage }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    replacePages(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, startPage, endPage, options = {}) {
      assertTwoSources(documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, options);
      if (!Number.isSafeInteger(startPage) || !Number.isSafeInteger(endPage) || startPage < 1 || endPage < startPage || endPage > 1_000_000) throw new TypeError('Replacement pages are invalid.');
      const context = { documentId, sourceSha256, secondaryDocumentId, secondarySourceSha256, startPage, endPage, type: 'replace-pages' };
      return json(documentPath(documentId, '/replace'), jsonOptions({ primarySourceSha256: sourceSha256, secondaryDocumentId, secondarySourceSha256, startPage, endPage }, options.signal)).then((body) => validateArtifactBody(body, context));
    },
    artifact(artifactId, { signal } = {}) { return blob(`/api/artifacts/${encodeURIComponent(artifactId)}`, { signal }); },
    async deleteArtifact(artifactId, { keepalive = false } = {}) { if (!OPAQUE_ID_PATTERN.test(artifactId ?? '') || typeof keepalive !== 'boolean') throw new TypeError('Artifact deletion options are invalid.'); await request(`/api/artifacts/${encodeURIComponent(artifactId)}`, { method: 'DELETE', keepalive }); },
    documentSource(documentId, { signal } = {}) { return blob(documentPath(documentId, '/source'), { signal }); },
    rewriteDocument(documentId, mode, { signal } = {}) { return json(documentPath(documentId, '/rewrite'), jsonOptions({ mode }, signal)).then((body) => body.document); },
    async deleteInput(inputId, { keepalive = false } = {}) { await request(`/api/inputs/${encodeURIComponent(inputId)}`, { method: 'DELETE', keepalive }); },
    async deleteDocument(documentId, { keepalive = false } = {}) { await request(documentPath(documentId, ''), { method: 'DELETE', keepalive }); },
  };
}
