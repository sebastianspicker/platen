import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract.js';
import { normalizeSnapshotRegion } from './snapshot-output.js';

const jsonOptions = (body, signal) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
const documentPath = (documentId, suffix) => `/api/documents/${encodeURIComponent(documentId)}${suffix}`;

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
    extractPages(documentId, pages, { signal } = {}) { return json(documentPath(documentId, '/extract'), jsonOptions({ pages }, signal)).then((body) => body.artifact); },
    arrangePages(documentId, pages, { signal } = {}) { return json(documentPath(documentId, '/arrange'), jsonOptions({ pages }, signal)).then((body) => body.artifact); },
    mergeDocuments(documentId, secondaryDocumentId, { signal } = {}) { return json(documentPath(documentId, '/merge'), jsonOptions({ secondaryDocumentId }, signal)).then((body) => body.artifact); },
    splitDocument(documentId, { signal } = {}) { return json(documentPath(documentId, '/split'), { method: 'POST', signal }).then((body) => body.artifacts); },
    splitByPageCount(documentId, pagesPerOutput, { signal } = {}) { return json(documentPath(documentId, '/split-rule'), jsonOptions({ pagesPerOutput }, signal)).then((body) => body.artifacts); },
    splitByVerifiedTopLevelOutline(documentId, { signal } = {}) { return json(documentPath(documentId, '/split-outline'), jsonOptions({ profile: 'macos-pdfkit-top-level-outline-split-v1' }, signal)).then((body) => body.artifacts); },
    duplicatePages(documentId, pages, { signal } = {}) { return json(documentPath(documentId, '/duplicate'), jsonOptions({ pages }, signal)).then((body) => body.artifact); },
    reversePages(documentId, { signal } = {}) { return json(documentPath(documentId, '/reverse'), { method: 'POST', signal }).then((body) => body.artifact); },
    interleaveDocuments(documentId, secondaryDocumentId, { signal } = {}) { return json(documentPath(documentId, '/interleave'), jsonOptions({ secondaryDocumentId }, signal)).then((body) => body.artifact); },
    insertDocument(documentId, secondaryDocumentId, afterPage, { signal } = {}) { return json(documentPath(documentId, '/insert'), jsonOptions({ secondaryDocumentId, afterPage }, signal)).then((body) => body.artifact); },
    replacePages(documentId, secondaryDocumentId, startPage, endPage, { signal } = {}) { return json(documentPath(documentId, '/replace'), jsonOptions({ secondaryDocumentId, startPage, endPage }, signal)).then((body) => body.artifact); },
    artifact(artifactId, { signal } = {}) { return blob(`/api/artifacts/${encodeURIComponent(artifactId)}`, { signal }); },
    async deleteArtifact(artifactId, { keepalive = false } = {}) { if (!OPAQUE_ID_PATTERN.test(artifactId ?? '') || typeof keepalive !== 'boolean') throw new TypeError('Artifact deletion options are invalid.'); await request(`/api/artifacts/${encodeURIComponent(artifactId)}`, { method: 'DELETE', keepalive }); },
    documentSource(documentId, { signal } = {}) { return blob(documentPath(documentId, '/source'), { signal }); },
    rewriteDocument(documentId, mode, { signal } = {}) { return json(documentPath(documentId, '/rewrite'), jsonOptions({ mode }, signal)).then((body) => body.document); },
    async deleteInput(inputId, { keepalive = false } = {}) { await request(`/api/inputs/${encodeURIComponent(inputId)}`, { method: 'DELETE', keepalive }); },
    async deleteDocument(documentId, { keepalive = false } = {}) { await request(documentPath(documentId, ''), { method: 'DELETE', keepalive }); },
  };
}
