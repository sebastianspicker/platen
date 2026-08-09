import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const DEFINITIONS = Object.freeze({
  form: Object.freeze({
    capabilityId: 'accessibility.form-semantics',
    operation: 'accessibility-form-semantics',
    operationType: 'pdf-accessibility-form-semantics',
    profile: 'local-accessibility-form-semantics-v1',
    method: 'production-accessibility-form-semantics-service',
    requestKeys: Object.freeze(['profile', 'sourceSha256', 'fields']),
    resultKeys: Object.freeze(['kind', 'schemaVersion', 'capabilityId', 'ok', 'localOnly', 'method', 'serviceReceipt', 'artifact', 'limitations', 'fields', 'count', 'bytes', 'outputSha256', 'sourceSha256', 'applied', 'proof', 'demoFixtureUsed', 'professionalProof', 'trustBoundary']),
  }),
  table: Object.freeze({
    capabilityId: 'accessibility.table-semantics',
    operation: 'accessibility-table-semantics',
    operationType: 'pdf-accessibility-table-semantics',
    profile: 'local-accessibility-table-semantics-v1',
    method: 'production-accessibility-table-semantics-service',
    requestKeys: Object.freeze(['profile', 'sourceSha256', 'table']),
    resultKeys: Object.freeze(['kind', 'schemaVersion', 'capabilityId', 'ok', 'localOnly', 'method', 'serviceReceipt', 'artifact', 'limitations', 'table', 'rowCount', 'columnCount', 'cellCount', 'bytes', 'outputSha256', 'sourceSha256', 'applied', 'structureLinked', 'proof', 'demoFixtureUsed', 'professionalProof', 'trustBoundary']),
  }),
  links: Object.freeze({
    capabilityId: 'accessibility.links-bookmarks',
    operation: 'accessibility-links-bookmarks',
    operationType: 'pdf-accessibility-links-bookmarks',
    profile: 'local-classic-incremental-links-bookmarks-v1',
    method: 'production-accessibility-links-bookmarks-service',
    requestKeys: Object.freeze(['profile', 'sourceSha256', 'links', 'bookmarks']),
    resultKeys: Object.freeze(['kind', 'schemaVersion', 'capabilityId', 'ok', 'localOnly', 'method', 'serviceReceipt', 'artifact', 'limitations', 'links', 'bookmarks', 'linkCount', 'bookmarkCount', 'bytes', 'outputSha256', 'sourceSha256', 'applied', 'proof', 'demoFixtureUsed', 'professionalProof', 'trustBoundary']),
  }),
});

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')
      && descriptors[key].enumerable === true);
}

function dense(value, { minimum = 0, maximum = 1_000 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(descriptors[index], 'value') || descriptors[index].enumerable !== true) return false;
  }
  return true;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function boundedText(value, { minimum = 1, maximum = 256, ascii = false } = {}) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    && value === value.normalize('NFC') && value.trim() === value
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)
    && (!ascii || /^[A-Za-z0-9._:-]+$/u.test(value));
}

function validReference(value) {
  return exact(value, ['object', 'generation'])
    && boundedInteger(value.object, 1, 1_000_000) && boundedInteger(value.generation, 0, 65_535);
}

function validFormRequest(request) {
  if (!dense(request.fields, { minimum: 1, maximum: 50 })) return false;
  const indexes = new Set();
  const targets = new Set();
  for (const field of request.fields) {
    if (!exact(field, ['target', 'role', 'name', 'tooltip', 'tabIndex'])
      || !exact(field.target, ['page', 'annotationIndex', 'fingerprint'])
      || !boundedInteger(field.target.page, 1, 10_000)
      || !boundedInteger(field.target.annotationIndex, 0, 49)
      || !SHA256.test(field.target.fingerprint ?? '')
      || !['text', 'button', 'choice'].includes(field.role)
      || !boundedText(field.name, { maximum: 127 })
      || !boundedText(field.tooltip, { minimum: 0, maximum: 127 })
      || !boundedInteger(field.tabIndex, 0, 49)) return false;
    const target = `${field.target.page}:${field.target.annotationIndex}`;
    if (indexes.has(field.tabIndex) || targets.has(target)) return false;
    indexes.add(field.tabIndex);
    targets.add(target);
  }
  return true;
}

function validTableRequest(request) {
  if (!exact(request.table, ['tableRef', 'cells']) || !validReference(request.table.tableRef)
    || !dense(request.table.cells, { minimum: 1, maximum: 400 })) return false;
  const ids = new Set();
  const references = new Set();
  const occupied = new Set();
  let rowCount = 0;
  let columnCount = 0;
  for (const cell of request.table.cells) {
    if (!exact(cell, ['id', 'structRef', 'role', 'row', 'column', 'page', 'contentRef', 'mcid', 'scope', 'headers', 'rowSpan', 'colSpan'])
      || !boundedText(cell.id, { maximum: 96, ascii: true }) || !validReference(cell.structRef)
      || !['TH', 'TD'].includes(cell.role) || (cell.scope !== null && !['row', 'column', 'both'].includes(cell.scope))
      || (cell.scope !== null && cell.role !== 'TH') || !boundedInteger(cell.row, 0, 99)
      || !boundedInteger(cell.column, 0, 99) || !boundedInteger(cell.page, 1, 10_000)
      || !validReference(cell.contentRef) || !boundedInteger(cell.mcid, 0, 10_000)
      || !dense(cell.headers, { maximum: 32 })
      || cell.headers.some((header) => !boundedText(header, { maximum: 96, ascii: true }))
      || !boundedInteger(cell.rowSpan, 1, 100) || !boundedInteger(cell.colSpan, 1, 100)) return false;
    const reference = `${cell.structRef.object}:${cell.structRef.generation}`;
    if (ids.has(cell.id) || references.has(reference)) return false;
    ids.add(cell.id);
    references.add(reference);
    rowCount = Math.max(rowCount, cell.row + cell.rowSpan);
    columnCount = Math.max(columnCount, cell.column + cell.colSpan);
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let column = cell.column; column < cell.column + cell.colSpan; column += 1) {
        const position = `${row}:${column}`;
        if (occupied.has(position)) return false;
        occupied.add(position);
      }
    }
  }
  const byId = new Map(request.table.cells.map((cell) => [cell.id, cell]));
  return occupied.size === rowCount * columnCount
    && request.table.cells.every((cell) => cell.headers.every((id) => byId.get(id)?.role === 'TH'));
}

function validLinksRequest(request) {
  if (!dense(request.links, { maximum: 64 }) || !dense(request.bookmarks, { maximum: 64 })
    || request.links.length + request.bookmarks.length < 1 || request.links.length + request.bookmarks.length > 64) return false;
  const fingerprints = [];
  for (const [entries, textKey] of [[request.links, 'purpose'], [request.bookmarks, 'title']]) {
    for (const entry of entries) {
      if (!exact(entry, ['locator', textKey, 'targetPage']) || !exact(entry.locator, ['fingerprint'])
        || !SHA256.test(entry.locator.fingerprint ?? '') || !boundedText(entry[textKey])
        || !boundedInteger(entry.targetPage, 1, 100)) return false;
      fingerprints.push(entry.locator.fingerprint);
    }
  }
  return new Set(fingerprints).size === fingerprints.length;
}

function validRequest(request, definition) {
  if (!exact(request, definition.requestKeys) || request.profile !== definition.profile
    || !SHA256.test(request.sourceSha256 ?? '')) return false;
  if (definition === DEFINITIONS.form) return validFormRequest(request);
  if (definition === DEFINITIONS.table) return validTableRequest(request);
  return validLinksRequest(request);
}

function validArtifact(artifact, { documentId, sourceSha256, outputSha256, bytes, definition }) {
  if (!exact(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    || !OPAQUE_ID_PATTERN.test(artifact.id ?? '') || artifact.id === documentId || artifact.documentId !== documentId
    || artifact.mediaType !== 'application/pdf' || artifact.sha256 !== outputSha256 || artifact.sha256 === sourceSha256
    || artifact.size !== bytes || !Number.isSafeInteger(artifact.size) || artifact.size < 64
    || typeof artifact.displayName !== 'string' || artifact.displayName.length < 1
    || typeof artifact.createdAt !== 'string' || Number.isNaN(Date.parse(artifact.createdAt))) return false;
  const operation = artifact.operation;
  return exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === definition.operationType && dense(operation.inputs, { minimum: 1, maximum: 32 })
    && operation.inputs.some((input) => exact(input, ['documentId', 'sha256', 'role'])
      && input.documentId === documentId && input.sha256 === sourceSha256 && input.role === 'source')
    && operation.parameters?.profile === definition.profile
    && operation.validation?.passed === true && operation.validation.outputSha256 === outputSha256
    && dense(operation.validation.validators, { minimum: 1, maximum: 64 })
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt));
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function validProof(result, definition, request) {
  const proof = result.proof;
  if (!proof || typeof proof !== 'object' || proof.sourcePrefixPreserved !== true) return false;
  if (definition === DEFINITIONS.form) {
    return proof.profile === definition.profile && proof.sourceSha256 === request.sourceSha256
      && proof.namesAndTooltipsBound === true
      && proof.tabOrder === 'S' && proof.fieldCount === result.count && result.fields.length === result.count;
  }
  if (definition === DEFINITIONS.table) {
    return proof.profile === definition.profile && proof.sourceSha256 === request.sourceSha256
      && proof.structureLinked === true
      && proof.contentStreamsUnchanged === true && proof.rowCount === result.rowCount
      && proof.columnCount === result.columnCount && proof.cellCount === result.cellCount
      && result.structureLinked === true;
  }
  return proof.profile === definition.profile && proof.hierarchyPreserved === true
    && dense(proof.links, { maximum: 64 }) && dense(proof.bookmarks, { maximum: 64 })
    && proof.links.length === result.linkCount && proof.bookmarks.length === result.bookmarkCount;
}

function validReceipt(result, definition) {
  const receipt = result.serviceReceipt;
  if (!receipt || receipt.kind !== definition.operationType || !sameJson(receipt.artifact, result.artifact)
    || !sameJson(receipt.limitations, result.limitations)) return false;
  if (definition === DEFINITIONS.links) {
    return receipt.sourceDigest === result.sourceSha256 && sameJson(receipt.operation, result.artifact.operation)
      && receipt.evidence?.localOnly === true && receipt.evidence?.sourceUnchanged === true
      && receipt.evidence?.artifactDigestBound === true;
  }
  return sameJson(receipt.proof, result.proof);
}

function validTableLocatorInventory(inventory, sourceSha256) {
  if (!exact(inventory, ['profile', 'sourceSha256', 'table']) || inventory.profile !== DEFINITIONS.table.profile
    || inventory.sourceSha256 !== sourceSha256 || !exact(inventory.table, ['tableRef', 'cells'])
    || !validReference(inventory.table.tableRef) || !dense(inventory.table.cells, { minimum: 1, maximum: 400 })) return false;
  return inventory.table.cells.every((cell) => exact(cell, ['structRef', 'role', 'row', 'column', 'page', 'contentRef', 'mcid', 'locator'])
    && validReference(cell.structRef) && ['TH', 'TD'].includes(cell.role)
    && boundedInteger(cell.row, 0, 99) && boundedInteger(cell.column, 0, 99)
    && boundedInteger(cell.page, 1, 10_000) && validReference(cell.contentRef)
    && boundedInteger(cell.mcid, 0, 10_000)
    && boundedText(cell.locator, { maximum: 160 }));
}

function validLinksLocatorInventory(inventory, sourceSha256) {
  if (!exact(inventory, ['links', 'bookmarks', 'pageCount']) || !dense(inventory.links, { maximum: 64 })
    || !dense(inventory.bookmarks, { maximum: 64 }) || !boundedInteger(inventory.pageCount, 1, 100)) return false;
  const fingerprints = [];
  for (const link of inventory.links) {
    if (!exact(link, ['fingerprint', 'page', 'annotationIndex', 'targetPage']) || !SHA256.test(link.fingerprint ?? '')
      || !boundedInteger(link.page, 1, inventory.pageCount) || !boundedInteger(link.annotationIndex, 0, 63)
      || !boundedInteger(link.targetPage, 1, inventory.pageCount)) return false;
    fingerprints.push(link.fingerprint);
  }
  for (const bookmark of inventory.bookmarks) {
    if (!exact(bookmark, ['fingerprint', 'targetPage', 'path']) || !SHA256.test(bookmark.fingerprint ?? '')
      || !boundedInteger(bookmark.targetPage, 1, inventory.pageCount) || !dense(bookmark.path, { minimum: 1, maximum: 64 })
      || bookmark.path.some((index) => !boundedInteger(index, 0, 63))) return false;
    fingerprints.push(bookmark.fingerprint);
  }
  return new Set(fingerprints).size === fingerprints.length && inventory.links.length + inventory.bookmarks.length > 0
    && inventory.links.length + inventory.bookmarks.length <= 64
    && sourceSha256.length === 64;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateProfessionalAccessibilityResult(result, { documentId, request, definition }) {
  if (!exact(result, definition.resultKeys) || result.kind !== 'professional-capability-result'
    || result.schemaVersion !== 1 || result.capabilityId !== definition.capabilityId
    || result.ok !== true || result.localOnly !== true || result.method !== definition.method
    || result.sourceSha256 !== request.sourceSha256 || !SHA256.test(result.outputSha256 ?? '')
    || result.applied !== true || result.demoFixtureUsed !== false || result.professionalProof !== true
    || !Number.isSafeInteger(result.bytes) || result.bytes < 64
    || !exact(result.trustBoundary, ['productionService', 'immutableSourceDigest', 'artifactReread', 'independentSemanticInspection'])
    || Object.values(result.trustBoundary).some((value) => value !== true)
    || !dense(result.limitations, { minimum: 1, maximum: 16 })
    || !validArtifact(result.artifact, {
      documentId, sourceSha256: request.sourceSha256, outputSha256: result.outputSha256,
      bytes: result.bytes, definition,
    })
    || !validReceipt(result, definition) || !validProof(result, definition, request)) {
    const error = new Error('The professional accessibility result is invalid.');
    error.code = 'INVALID_LOCAL_HOST';
    throw error;
  }
  return deepFreeze(result);
}

function validateLocatorInventoryResult(result, { capabilityId, sourceSha256 }) {
  const validInventory = capabilityId === DEFINITIONS.table.capabilityId
    ? validTableLocatorInventory(result?.inventory, sourceSha256)
    : validLinksLocatorInventory(result?.inventory, sourceSha256);
  if (!exact(result, ['kind', 'schemaVersion', 'capabilityId', 'sourceSha256', 'inventory'])
    || result.kind !== 'professional-accessibility-locator-inventory' || result.schemaVersion !== 1
    || result.capabilityId !== capabilityId || result.sourceSha256 !== sourceSha256 || !validInventory) {
    const error = new Error('The professional accessibility locator inventory is invalid.');
    error.code = 'INVALID_LOCAL_HOST';
    throw error;
  }
  return deepFreeze(result);
}

function endpoint(json, definition, documentId, request, options) {
  const optionKeys = options?.signal === undefined ? [] : ['signal'];
  if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validRequest(request, definition)
    || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new TypeError('Professional accessibility request is invalid.');
  }
  const fixedRequest = structuredClone(request);
  return json(`/api/documents/${encodeURIComponent(documentId)}/${definition.operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixedRequest), signal: options.signal,
  }).then((body) => validateProfessionalAccessibilityResult(body?.result, {
    documentId, request: fixedRequest, definition,
  }));
}

function inventoryEndpoint(json, definition, documentId, sourceSha256, options) {
  const optionKeys = options?.signal === undefined ? [] : ['signal'];
  if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
    || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new TypeError('Professional accessibility locator inventory request is invalid.');
  }
  const request = Object.freeze({ sourceSha256 });
  const operation = definition === DEFINITIONS.table ? 'accessibility-table-semantics-inventory' : 'accessibility-links-bookmarks-inventory';
  return json(`/api/documents/${encodeURIComponent(documentId)}/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal,
  }).then((body) => validateLocatorInventoryResult(body?.result, { capabilityId: definition.capabilityId, sourceSha256 }));
}

export function createProfessionalAccessibilityEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Professional accessibility endpoints require JSON transport.');
  return Object.freeze({
    repairAccessibilityFormSemantics(documentId, request, options = {}) {
      return endpoint(json, DEFINITIONS.form, documentId, request, options);
    },
    repairAccessibilityTableSemantics(documentId, request, options = {}) {
      return endpoint(json, DEFINITIONS.table, documentId, request, options);
    },
    repairAccessibilityLinksBookmarks(documentId, request, options = {}) {
      return endpoint(json, DEFINITIONS.links, documentId, request, options);
    },
    inspectAccessibilityTableSemanticsLocators(documentId, sourceSha256, options = {}) {
      return inventoryEndpoint(json, DEFINITIONS.table, documentId, sourceSha256, options);
    },
    inspectAccessibilityLinksBookmarksLocators(documentId, sourceSha256, options = {}) {
      return inventoryEndpoint(json, DEFINITIONS.links, documentId, sourceSha256, options);
    },
  });
}

export { DEFINITIONS as PROFESSIONAL_ACCESSIBILITY_DEFINITIONS };
