/**
 * Source-bound adapters for the page-organization services.
 *
 * This module deliberately never synthesizes a stand-in PDF.  A successful
 * result is an artifact retained by the local document store after the owning
 * service has verified immutable inputs and its output.  The adapter rereads
 * that artifact and independently checks its digest, PDF shape, provenance,
 * and requested page-selection semantics before returning it.
 */
import { readFileSync } from 'node:fs';
import { OPAQUE_ID } from '../document-store-contract.mjs';
import { validateOperationProvenance } from '../operation-provenance.mjs';
import { PDF_COPY_PAGE_PROFILE } from '../pdf-copy-page-contract.mjs';
import { PDF_PAGE_LABELS_PROFILE } from '../pdf-page-labels-contract.mjs';
import { INCREMENTAL_PAGE_TRANSITION_PROFILE } from '../pdf-incremental-page-transition-contract.mjs';
import { PDFKIT_DERIVED_PROFILE } from '../pdfkit-mutation-contract.mjs';
import { result, fail, sha256 } from './support.mjs';

const DIGEST = /^[0-9a-f]{64}$/u;
const PAGE_TREE_COUNT = /\/Type\s*\/Pages\b[\s\S]{0,2048}?\/Count\s+(\d+)/gu;

function unavailable(message) {
  fail('PAGES_SERVICE_UNAVAILABLE', message, 503);
}

function invalid(message) {
  fail('PAGES_CONTEXT_INVALID', message, 400);
}

function outputInvalid(message) {
  fail('PAGES_OUTPUT_INVALID', message, 502);
}

function requiredStore(ctx) {
  const store = ctx.store;
  if (!store || ['getDocument', 'verifySource', 'getArtifact'].some((name) => typeof store[name] !== 'function')) {
    unavailable('Page organization requires a source-bound local document store.');
  }
  return store;
}

function id(value, label) {
  if (!OPAQUE_ID.test(String(value ?? ''))) invalid(`${label} must be a local document identifier.`);
  return value;
}

function digest(value, label) {
  if (!DIGEST.test(String(value ?? ''))) invalid(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function sourceRecord(store, documentId, sourceSha256, label) {
  let record;
  try {
    record = store.getDocument(documentId);
  } catch (error) {
    if (error?.code === 'DOCUMENT_NOT_FOUND') invalid(`${label} source document was not found.`);
    outputInvalid(`Could not read the ${label.toLowerCase()} source binding.`);
  }
  if (!record || record.id !== documentId || record.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(record.size) || record.size < 5 || !DIGEST.test(record.sha256 ?? '')) {
    invalid(`${label} source binding is malformed.`);
  }
  if (sourceSha256 !== record.sha256) {
    fail('SOURCE_VERSION_MISMATCH', `${label} source digest does not match the current document.`, 409);
  }
  return record;
}

async function sources(ctx, { secondary = false } = {}) {
  const store = requiredStore(ctx);
  const primaryId = id(ctx.documentId, 'documentId');
  const primary = sourceRecord(store, primaryId, digest(ctx.sourceSha256, 'sourceSha256'), 'Primary');
  let secondaryRecord = null;
  if (secondary) {
    const secondaryId = id(ctx.secondaryDocumentId, 'secondaryDocumentId');
    if (secondaryId === primaryId) invalid('Secondary document must differ from the primary document.');
    secondaryRecord = sourceRecord(
      store,
      secondaryId,
      digest(ctx.secondarySourceSha256, 'secondarySourceSha256'),
      'Secondary',
    );
  }
  try {
    await store.verifySource(primary.id);
    if (secondaryRecord) await store.verifySource(secondaryRecord.id);
  } catch (error) {
    if (error?.code === 'SOURCE_INTEGRITY_FAILED') {
      fail('PAGES_SOURCE_INTEGRITY_FAILED', 'An immutable page-organization source changed before processing.', 502);
    }
    outputInvalid('Page-organization sources could not be verified.');
  }
  return Object.freeze({ store, primary, secondary: secondaryRecord });
}

function service(ctx, method) {
  if (!ctx.service || typeof ctx.service[method] !== 'function') {
    unavailable(`Page organization requires the local ${method} service.`);
  }
  return ctx.service;
}

function exactInputs(operation, expected) {
  return JSON.stringify(operation.inputs) === JSON.stringify(expected);
}

function pageCount(bytes) {
  const matches = [...bytes.toString('latin1').matchAll(PAGE_TREE_COUNT)];
  const count = Number(matches.at(-1)?.[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : -1;
}

function semanticSelections(operation, expected) {
  return JSON.stringify(operation.parameters?.selections) === JSON.stringify(expected);
}

function checkOperation(artifact, {
  type,
  inputs,
  expectedPageCount,
  provenancePageCount = true,
  selections = null,
  validation = [],
  extra = null,
}) {
  let operation;
  try {
    operation = validateOperationProvenance(artifact.operation);
  } catch {
    outputInvalid('The retained page-organization artifact has invalid provenance.');
  }
  if (operation.type !== type || !exactInputs(operation, inputs)
    || (provenancePageCount && operation.expected?.pageCount !== expectedPageCount)
    || operation.validation?.passed !== true
    || (provenancePageCount && operation.validation?.pageCount !== expectedPageCount)
    || validation.some((validator) => !operation.validation.validators.includes(validator))
    || (selections && !semanticSelections(operation, selections))
    || (extra && !extra(operation))) {
    outputInvalid('The retained page-organization artifact does not prove the requested operation.');
  }
  return operation;
}

function rereadArtifact(store, returned, expected) {
  if (!returned || !OPAQUE_ID.test(String(returned.id ?? ''))) {
    outputInvalid('The page-organization service did not return a retained artifact.');
  }
  let artifact;
  try {
    artifact = store.getArtifact(returned.id);
  } catch {
    outputInvalid('The page-organization artifact could not be reread from the local store.');
  }
  if (!artifact || artifact.id !== returned.id || artifact.documentId !== expected.owner.id
    || artifact.mediaType !== 'application/pdf' || !DIGEST.test(artifact.sha256 ?? '')
    || !Number.isSafeInteger(artifact.size) || artifact.size < 5 || typeof artifact.filePath !== 'string') {
    outputInvalid('The page-organization artifact receipt is malformed.');
  }
  let bytes;
  try {
    bytes = readFileSync(artifact.filePath);
  } catch {
    outputInvalid('Page-organization artifact bytes could not be reread.');
  }
  const structuralPageCount = pageCount(bytes);
  if (!Buffer.isBuffer(bytes) || bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256
    || !bytes.subarray(0, Math.min(1024, bytes.length)).includes(Buffer.from('%PDF-', 'ascii'))
    || structuralPageCount !== expected.expectedPageCount) {
    outputInvalid('The reread page-organization artifact failed independent digest or page-tree validation.');
  }
  const operation = checkOperation(artifact, expected);
  return Object.freeze({ artifact, bytes, operation });
}

async function complete(ctx, binding, returned, expected, capabilityId, method, payload = {}) {
  const checked = rereadArtifact(binding.store, returned, { ...expected, owner: binding.primary });
  try {
    await binding.store.verifySource(binding.primary.id);
    if (binding.secondary) await binding.store.verifySource(binding.secondary.id);
  } catch {
    fail('PAGES_SOURCE_INTEGRITY_FAILED', 'An immutable page-organization source changed during processing.', 502);
  }
  return result(capabilityId, {
    method,
    sourceSha256: binding.primary.sha256,
    ...(binding.secondary ? { secondarySourceSha256: binding.secondary.sha256 } : {}),
    artifact: checked.artifact,
    operation: checked.operation,
    pdf: checked.bytes,
    bytes: checked.bytes.length,
    outputSha256: checked.artifact.sha256,
    pageCount: expected.expectedPageCount,
    semanticValidation: 'provenance-selection-and-reread-page-tree-v1',
    ...payload,
  });
}

function pages(value, label = 'pages') {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500
    || value.some((page) => !Number.isSafeInteger(page) || page < 1)) {
    invalid(`${label} must contain from 1 through 500 positive page numbers.`);
  }
  return [...value];
}

function selectedPages(ctx, label = 'pages') {
  return pages(ctx.pages ?? ctx.pageNumbers ?? ctx.order, label);
}

function compositionInputs(binding) {
  return [
    { documentId: binding.primary.id, sha256: binding.primary.sha256, role: 'primary' },
    ...(binding.secondary ? [{ documentId: binding.secondary.id, sha256: binding.secondary.sha256, role: 'source-1' }] : []),
  ];
}

function mergeInputs(binding) {
  return [
    { documentId: binding.primary.id, sha256: binding.primary.sha256, role: 'primary' },
    { documentId: binding.secondary.id, sha256: binding.secondary.sha256, role: 'secondary' },
  ];
}

function selected(binding, values, secondary = false) {
  return values.map((page) => ({ input: secondary ? 1 : 0, page }));
}


export {
  unavailable, invalid, outputInvalid, sources, service, complete, pages, selectedPages,
  compositionInputs, mergeInputs, selected,
};
