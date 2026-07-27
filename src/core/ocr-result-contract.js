import {
  CLEANUP_PRESETS,
  digest,
  DOCUMENT_ID,
  exactObject,
  freeze,
  invalid,
  LANGUAGE_TOKEN,
  nonEmptyStrings,
  OCR_LIMITS,
  positiveInteger,
  SEGMENTATION_MODES,
  ZONE_ID,
  ZONE_TYPES,
} from './ocr-contract-shared.js';

function validateEvidence(value, requiredKeys) {
  exactObject(value, requiredKeys, 'OCR evidence');
  if (value.localOnly !== true || value.sourceBound !== true) invalid('OCR evidence must be local-only and source-bound.');
  nonEmptyStrings(value.engines, 'OCR evidence engines', { maximumItems: 3, maximumLength: 32 });
  if (new Set(value.engines).size !== value.engines.length
    || value.engines.some((engine) => !['Poppler', 'ImageMagick', 'Tesseract'].includes(engine))) invalid('OCR evidence contains an unsupported engine.');
}

function validateArtifact(value) {
  exactObject(value, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'], 'OCR artifact');
  if (typeof value.id !== 'string' || !DOCUMENT_ID.test(value.id)
    || typeof value.documentId !== 'string' || !DOCUMENT_ID.test(value.documentId)
    || typeof value.displayName !== 'string' || !value.displayName || value.displayName.length > 240
    || value.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 512 * 1024 * 1024
    || !value.operation || typeof value.operation !== 'object' || Array.isArray(value.operation)
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) invalid('OCR artifact metadata is invalid.');
  digest(value.sha256, 'OCR artifact digest');
}

function normalizedBounds(value, label, { positive = false } = {}) {
  exactObject(value, ['x', 'y', 'width', 'height'], label);
  if (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))
    || value.x < 0 || value.y < 0 || value.width < (positive ? OCR_LIMITS.minNormalizedZoneSize : 0)
    || value.height < (positive ? OCR_LIMITS.minNormalizedZoneSize : 0)
    || value.x + value.width > 1.000001 || value.y + value.height > 1.000001) invalid(`${label} is invalid.`);
}

function validateLayoutNode(value) {
  exactObject(value, ['id', 'level', 'page', 'block', 'paragraph', 'line', 'word', 'confidence', 'text', 'bounds'], 'OCR layout node');
  if (typeof value.id !== 'string' || value.id.length < 9 || value.id.length > 128
    || !Number.isSafeInteger(value.level) || value.level < 1 || value.level > 5
    || !['page', 'block', 'paragraph', 'line', 'word'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= (key === 'page' ? 1 : 0))
    || !Number.isFinite(value.confidence) || value.confidence < -1 || value.confidence > 100
    || typeof value.text !== 'string' || value.text.length > 4_000) invalid('OCR layout node is invalid.');
  normalizedBounds(value.bounds, 'OCR layout node bounds');
}

function validateTableCandidate(value) {
  exactObject(value, ['method', 'reviewRequired', 'alignmentScore', 'rows', 'columns', 'truncated', 'bounds', 'wordIds', 'grid'], 'OCR table candidate');
  if (value.method !== 'tesseract-tsv-geometry-heuristic' || value.reviewRequired !== true
    || !Number.isFinite(value.alignmentScore) || value.alignmentScore < 0.6 || value.alignmentScore > 1
    || !Number.isSafeInteger(value.rows) || value.rows < 2 || value.rows > 200
    || !Number.isSafeInteger(value.columns) || value.columns < 2 || value.columns > 32
    || typeof value.truncated !== 'boolean' || !Array.isArray(value.wordIds) || value.wordIds.length < 4 || value.wordIds.length > 100_000
    || value.wordIds.some((id) => typeof id !== 'string' || id.length < 9 || id.length > 128)
    || !Array.isArray(value.grid) || value.grid.length !== value.rows) invalid('OCR table candidate is invalid.');
  normalizedBounds(value.bounds, 'OCR table bounds');
  for (const row of value.grid) {
    if (!Array.isArray(row) || row.length !== value.columns) invalid('OCR table grid dimensions are inconsistent.');
    for (const cell of row) {
      exactObject(cell, ['text', 'wordIds', 'bounds', 'truncated'], 'OCR table cell');
      if (typeof cell.text !== 'string' || cell.text.length > 4_000 || cell.text.includes('\0')
        || !Array.isArray(cell.wordIds) || cell.wordIds.length > 100_000
        || cell.wordIds.some((id) => typeof id !== 'string' || id.length < 9 || id.length > 128)
        || typeof cell.truncated !== 'boolean') invalid('OCR table cell is invalid.');
      if (cell.bounds !== null) normalizedBounds(cell.bounds, 'OCR table cell bounds');
    }
  }
}

function validateAlto(value) {
  exactObject(value, ['mediaType', 'encoding', 'byteLength', 'sha256', 'data'], 'OCR ALTO evidence');
  const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (value.mediaType !== 'application/alto+xml' || value.encoding !== 'base64'
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > 2 * 1024 * 1024
    || typeof value.data !== 'string' || value.data.length < 4 || value.data.length > 2_796_208 || !base64.test(value.data)) invalid('OCR ALTO evidence is invalid.');
  digest(value.sha256, 'OCR ALTO digest');
  const padding = value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0;
  if (value.data.length / 4 * 3 - padding !== value.byteLength) invalid('OCR ALTO byte length is inconsistent.');
}

function validateLayoutRecord(value) {
  exactObject(value, ['page', 'pageSize', 'zoneId', 'zoneType', 'region', 'dpi', 'classificationOnly', 'recognizedWordCount', 'layout', 'tableCandidates', 'alto'], 'OCR layout record');
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > 1_000_000
    || typeof value.zoneId !== 'string' || !ZONE_ID.test(value.zoneId) || !ZONE_TYPES.includes(value.zoneType)
    || !Number.isSafeInteger(value.dpi) || value.dpi < 72 || value.dpi > 600
    || !Number.isSafeInteger(value.recognizedWordCount) || value.recognizedWordCount < 0
    || !Array.isArray(value.tableCandidates) || value.tableCandidates.length > 1) invalid('OCR layout record is invalid.');
  exactObject(value.pageSize, ['page', 'widthPoints', 'heightPoints'], 'OCR layout page size');
  if (value.pageSize.page !== value.page || !Number.isFinite(value.pageSize.widthPoints) || value.pageSize.widthPoints <= 0 || value.pageSize.widthPoints > 14_400
    || !Number.isFinite(value.pageSize.heightPoints) || value.pageSize.heightPoints <= 0 || value.pageSize.heightPoints > 14_400) invalid('OCR layout page size is invalid.');
  normalizedBounds(value.region, 'OCR layout region', { positive: true });
  if (value.classificationOnly === true) {
    if (!['image', 'exclude'].includes(value.zoneType) || value.recognizedWordCount !== 0 || value.layout !== null
      || value.tableCandidates.length || value.alto !== null) invalid('Classification-only OCR record contains recognition evidence.');
    return;
  }
  if (value.classificationOnly !== false || !['text', 'table'].includes(value.zoneType)
    || !value.layout || typeof value.layout !== 'object' || Array.isArray(value.layout)) invalid('Recognized OCR record is invalid.');
  exactObject(value.layout, ['schemaVersion', 'image', 'nodes', 'words', 'tableCandidates'], 'OCR layout hierarchy');
  if (value.layout.schemaVersion !== 1 || !Array.isArray(value.layout.nodes) || value.layout.nodes.length > 100_000
    || !Array.isArray(value.layout.words) || value.layout.words.length > 100_000
    || value.layout.words.length !== value.recognizedWordCount || !Array.isArray(value.layout.tableCandidates)
    || value.layout.tableCandidates.length > 1) invalid('OCR layout hierarchy is invalid.');
  exactObject(value.layout.image, ['width', 'height', 'zone'], 'OCR layout raster');
  if (!Number.isSafeInteger(value.layout.image.width) || value.layout.image.width < 1 || value.layout.image.width > 16_384
    || !Number.isSafeInteger(value.layout.image.height) || value.layout.image.height < 1 || value.layout.image.height > 16_384) invalid('OCR layout raster is invalid.');
  normalizedBounds(value.layout.image.zone, 'OCR layout raster zone', { positive: true });
  value.layout.nodes.forEach(validateLayoutNode);
  value.layout.words.forEach(validateLayoutNode);
  value.tableCandidates.forEach(validateTableCandidate);
  value.layout.tableCandidates.forEach(validateTableCandidate);
  if (JSON.stringify(value.tableCandidates) !== JSON.stringify(value.layout.tableCandidates)) invalid('OCR table evidence is inconsistent across the result record.');
  validateAlto(value.alto);
}

function validateDimensions(value, label) {
  exactObject(value, ['width', 'height'], label);
  if (!Number.isSafeInteger(value.width) || value.width < 1 || value.width > 1_000_000
    || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 1_000_000) invalid(`${label} is invalid.`);
}

function validateCleanupReceipt(value) {
  exactObject(value, ['page', 'applied', 'preset', 'pre', 'post', 'canvasPreserved'], 'OCR cleanup receipt');
  positiveInteger(value.page, 'OCR cleanup receipt page', OCR_LIMITS.maxDocumentPages);
  if (typeof value.applied !== 'boolean' || !CLEANUP_PRESETS.includes(value.preset) || value.canvasPreserved !== true) invalid('OCR cleanup receipt state is invalid.');
  for (const [label, record] of [['pre', value.pre], ['post', value.post]]) {
    exactObject(record, ['sha256', 'width', 'height'], `OCR cleanup ${label} record`);
    digest(record.sha256, `OCR cleanup ${label} digest`);
    validateDimensions({ width: record.width, height: record.height }, `OCR cleanup ${label} dimensions`);
  }
  if (value.pre.width !== value.post.width || value.pre.height !== value.post.height) invalid('OCR cleanup receipt must preserve the raster canvas.');
  if (value.applied !== (value.preset !== 'none')) invalid('OCR cleanup applied state is inconsistent with its preset.');
}

function validateDocumentPayload(value) {
  exactObject(value, ['language', 'pageCount', 'recognizedWordCount', 'rasterized', 'cleanupPreset', 'segmentation', 'userDictionary', 'suspects'], 'OCR document payload');
  if (typeof value.language !== 'string' || value.language.length > 128
    || !value.language.split('+').every((token) => LANGUAGE_TOKEN.test(token))
    || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > OCR_LIMITS.maxDocumentPages
    || !Number.isSafeInteger(value.recognizedWordCount) || value.recognizedWordCount < 1
    || value.rasterized !== true || !CLEANUP_PRESETS.includes(value.cleanupPreset)
    || !SEGMENTATION_MODES.includes(value.segmentation)) invalid('OCR document payload is invalid.');
  exactObject(value.userDictionary, ['termCount', 'digest'], 'OCR user dictionary evidence');
  if (!Number.isSafeInteger(value.userDictionary.termCount) || value.userDictionary.termCount < 0
    || value.userDictionary.termCount > OCR_LIMITS.maxUserDictionaryTerms
    || (value.userDictionary.termCount === 0 && value.userDictionary.digest !== null)
    || (value.userDictionary.termCount > 0 && !/^[a-f0-9]{64}$/.test(value.userDictionary.digest))) invalid('OCR user dictionary evidence is invalid.');
  if (!Array.isArray(value.suspects) || value.suspects.length > 500) invalid('OCR suspect evidence is invalid.');
  for (const suspect of value.suspects) {
    exactObject(suspect, ['page', 'text', 'confidence', 'left', 'top', 'width', 'height'], 'OCR suspect');
    if (!Number.isSafeInteger(suspect.page) || suspect.page < 1 || suspect.page > value.pageCount
      || typeof suspect.text !== 'string' || !suspect.text || suspect.text.length > 4_096
      || !Number.isFinite(suspect.confidence) || suspect.confidence < -1 || suspect.confidence > 100
      || !['left', 'top', 'width', 'height'].every((key) => Number.isSafeInteger(suspect[key]) && suspect[key] >= 0)) invalid('OCR suspect evidence is invalid.');
  }
}

function result(value, kind, required, { sourceDigest = true } = {}) {
  exactObject(value, required, 'OCR result');
  if (value.kind !== kind || value.schemaVersion !== 1) invalid('OCR result kind or schema version is invalid.');
  if (sourceDigest) digest(value.sourceDigest, 'OCR source digest');
  nonEmptyStrings(value.limitations, 'OCR limitations');
  return freeze(structuredClone(value));
}

export function validateOcrDocumentResult(value) {
  const checked = result(value, 'searchable-ocr-document', ['kind', 'schemaVersion', 'sourceDigest', 'artifact', 'result', 'evidence', 'limitations']);
  validateArtifact(checked.artifact);
  validateDocumentPayload(checked.result);
  validateEvidence(checked.evidence, ['localOnly', 'sourceBound', 'engines', 'rasterized', 'reviewRequired', 'cleanupReceipts']);
  if (checked.evidence.rasterized !== true || checked.evidence.reviewRequired !== true) invalid('OCR document evidence is invalid.');
  if (!Array.isArray(checked.evidence.cleanupReceipts) || checked.evidence.cleanupReceipts.length !== checked.result.pageCount) invalid('OCR cleanup receipts must cover every page.');
  checked.evidence.cleanupReceipts.forEach(validateCleanupReceipt);
  if (new Set(checked.evidence.cleanupReceipts.map(({ page }) => page)).size !== checked.evidence.cleanupReceipts.length) invalid('OCR cleanup receipt pages must be unique.');
  const requiredEngines = checked.result.cleanupPreset === 'none' ? ['Poppler', 'Tesseract'] : ['Poppler', 'ImageMagick', 'Tesseract'];
  if (JSON.stringify(checked.evidence.engines) !== JSON.stringify(requiredEngines)) invalid('OCR document engine evidence is inconsistent with the cleanup preset.');
  const operation = checked.artifact.operation;
  if (operation.schemaVersion !== 1 || operation.type !== 'searchable-ocr' || !Array.isArray(operation.inputs)
    || !operation.inputs.some((input) => input?.documentId === checked.artifact.documentId && input.sha256 === checked.sourceDigest)
    || operation.validation?.passed !== true || operation.validation?.recognizedWordCount !== checked.result.recognizedWordCount
    || JSON.stringify(operation.parameters?.cleanupReceipts) !== JSON.stringify(checked.evidence.cleanupReceipts)
    || JSON.stringify(operation.parameters?.userDictionary) !== JSON.stringify(checked.result.userDictionary)) invalid('OCR artifact provenance is not bound to its versioned result.');
  return checked;
}

export function validateOcrLayoutResult(value) {
  const checked = result(value, 'ocr-layout-evidence', ['kind', 'schemaVersion', 'sourceDigest', 'language', 'cleanupPreset', 'segmentation', 'detectTables', 'records', 'evidence', 'limitations']);
  if (typeof checked.language !== 'string' || checked.language.length > 128
    || !checked.language.split('+').every((token) => LANGUAGE_TOKEN.test(token))
    || !CLEANUP_PRESETS.includes(checked.cleanupPreset) || !SEGMENTATION_MODES.includes(checked.segmentation)
    || typeof checked.detectTables !== 'boolean' || !Array.isArray(checked.records)
    || !checked.records.length || checked.records.length > OCR_LIMITS.maxZones) invalid('OCR layout result is invalid.');
  checked.records.forEach(validateLayoutRecord);
  if (new Set(checked.records.map(({ zoneId }) => zoneId)).size !== checked.records.length) invalid('OCR layout result zone IDs must be unique.');
  validateEvidence(checked.evidence, ['localOnly', 'sourceBound', 'engines', 'tableMethod', 'reviewRequired']);
  if (checked.evidence.tableMethod !== null && checked.evidence.tableMethod !== 'tesseract-tsv-geometry-heuristic'
    || typeof checked.evidence.reviewRequired !== 'boolean'
    || checked.evidence.reviewRequired !== checked.detectTables
    || checked.evidence.tableMethod !== (checked.detectTables ? 'tesseract-tsv-geometry-heuristic' : null)) invalid('OCR layout evidence is invalid.');
  return checked;
}

export function validateOcrBatchManifest(value) {
  const checked = result(value, 'ocr-batch-manifest', ['kind', 'schemaVersion', 'status', 'requests', 'evidence', 'limitations'], { sourceDigest: false });
  if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(checked.status)
    || !Array.isArray(checked.requests) || !checked.requests.length || checked.requests.length > OCR_LIMITS.maxBatchRequests) invalid('OCR batch manifest is invalid.');
  const ids = new Set(); let completed = 0; let cancelled = 0;
  for (const [index, entry] of checked.requests.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('OCR batch result entry is invalid.');
    positiveInteger(entry.id, 'OCR batch result ID', OCR_LIMITS.maxBatchRequests);
    if (entry.id !== index + 1 || ids.has(entry.id) || typeof entry.documentId !== 'string' || !DOCUMENT_ID.test(entry.documentId) || entry.kind !== 'document') invalid('OCR batch result identity is invalid.');
    ids.add(entry.id);
    if (entry.status === 'completed') {
      exactObject(entry, ['id', 'documentId', 'kind', 'status', 'output'], 'Completed OCR batch entry');
      validateOcrDocumentResult(entry.output); completed += 1;
      if (entry.output.artifact.documentId !== entry.documentId) invalid('OCR batch artifact ownership is inconsistent.');
    } else {
      exactObject(entry, ['id', 'documentId', 'kind', 'status', 'error'], 'Terminal OCR batch entry');
      if (!['failed', 'cancelled'].includes(entry.status)) invalid('OCR batch entry status is invalid.');
      exactObject(entry.error, ['code', 'message'], 'OCR batch error');
      if (typeof entry.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(entry.error.code)
        || typeof entry.error.message !== 'string' || !entry.error.message || entry.error.message.length > 240) invalid('OCR batch error is invalid.');
      if (entry.status === 'cancelled') cancelled += 1;
    }
  }
  validateEvidence(checked.evidence, ['localOnly', 'sourceBound', 'engines', 'ordered', 'sequential', 'aggregatePages', 'aggregateInputBytes', 'aggregateOutputBytes']);
  if (checked.evidence.ordered !== true || checked.evidence.sequential !== true
    || !Number.isSafeInteger(checked.evidence.aggregatePages) || checked.evidence.aggregatePages < 1 || checked.evidence.aggregatePages > OCR_LIMITS.maxDocumentPages
    || !Number.isSafeInteger(checked.evidence.aggregateInputBytes) || checked.evidence.aggregateInputBytes < 1 || checked.evidence.aggregateInputBytes > 512 * 1024 * 1024
    || !Number.isSafeInteger(checked.evidence.aggregateOutputBytes) || checked.evidence.aggregateOutputBytes < 0 || checked.evidence.aggregateOutputBytes > 512 * 1024 * 1024
    || checked.evidence.aggregateInputBytes + checked.evidence.aggregateOutputBytes > 512 * 1024 * 1024) invalid('OCR batch ordering or quota evidence is invalid.');
  const expectedStatus = completed === checked.requests.length ? 'succeeded'
    : completed > 0 ? 'partial'
      : cancelled > 0 ? 'cancelled' : 'failed';
  if (checked.status !== expectedStatus) invalid('OCR batch aggregate status is inconsistent.');
  const completedOutputs = checked.requests.filter(({ status }) => status === 'completed').map(({ output }) => output);
  if (completedOutputs.reduce((total, output) => total + output.artifact.size, 0) !== checked.evidence.aggregateOutputBytes
    || completedOutputs.reduce((total, output) => total + output.result.pageCount, 0) > checked.evidence.aggregatePages) invalid('OCR batch aggregate evidence is inconsistent.');
  return checked;
}
