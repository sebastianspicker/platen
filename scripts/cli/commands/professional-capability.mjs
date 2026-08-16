import { basename } from 'node:path';
import { normalizePdfAccessibilityFormSemantics } from '../../host/pdf-accessibility-form-semantics-contract.mjs';
import { normalizePdfAccessibilityLinksBookmarks } from '../../host/pdf-accessibility-links-bookmarks-contract.mjs';
import { normalizePdfAccessibilityTableSemantics } from '../../host/pdf-accessibility-table-semantics-contract.mjs';
import { normalizePdfTextEditRequest } from '../../host/pdf-text-edit-contract.mjs';
import { normalizeIncrementalMetadata } from '../../host/pdf-incremental-metadata-contract.mjs';
import { runSourceBoundHeaderFooterEdit } from './professional-header-footer.mjs';
import { runSourceBoundPageOrganization } from './professional-page-organization.mjs';

const SOURCE_BOUND_ACCESSIBILITY = Object.freeze({
  'accessibility.form-semantics': normalizePdfAccessibilityFormSemantics,
  'accessibility.table-semantics': normalizePdfAccessibilityTableSemantics,
  'accessibility.links-bookmarks': normalizePdfAccessibilityLinksBookmarks,
});
const SOURCE_BOUND_TEXT_EDIT = Object.freeze(new Set(['edit.text', 'edit.find-replace']));
const SOURCE_BOUND_METADATA_EDIT = Object.freeze(new Set(['document.metadata-edit']));
const SOURCE_BOUND_PAGE_ORGANIZATION = Object.freeze(new Set(['pages.page-boxes', 'pages.insert-blank']));
const SOURCE_BOUND_HEADER_FOOTER_EDIT = Object.freeze(new Set(['edit.headers-footers']));

function normalizeSourceBoundAccessibility(capabilityId, value) {
  if (!Object.hasOwn(SOURCE_BOUND_ACCESSIBILITY, capabilityId)) return null;
  if (capabilityId === 'accessibility.form-semantics') return normalizePdfAccessibilityFormSemantics(value);
  if (capabilityId === 'accessibility.table-semantics') return normalizePdfAccessibilityTableSemantics(value);
  if (capabilityId === 'accessibility.links-bookmarks') return normalizePdfAccessibilityLinksBookmarks(value);
  return null;
}

function sanitizeMetadataRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const metadata = Object.getOwnPropertyDescriptor(value, 'metadata');
  const sourceSha256 = Object.getOwnPropertyDescriptor(value, 'sourceSha256');
  if (!metadata || !sourceSha256 || !('value' in metadata) || !('value' in sourceSha256)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.every((key) => key === 'sourceSha256' || key === 'metadata')) {
    return null;
  }
  if (typeof sourceSha256.value !== 'string' || !/^[0-9a-f]{64}$/u.test(sourceSha256.value)) {
    return null;
  }
  try {
    return Object.freeze({
      sourceSha256: sourceSha256.value,
      metadata: normalizeIncrementalMetadata(metadata.value),
    });
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_METADATA') return null;
    throw error;
  }
}

function sanitizeMetadataEditReceipt(result, output) {
  const {
    pdf: _pdf,
    metadata: _metadata,
    sourceSha256: _sourceSha256,
    serviceReceipt: sourceBoundServiceReceipt,
    ...rest
  } = result;
  const sanitizeServiceReceipt = sourceBoundServiceReceipt && typeof sourceBoundServiceReceipt === 'object' && !Array.isArray(sourceBoundServiceReceipt)
    ? (() => {
      const {
        metadata: _serviceMetadata,
        artifact: sourceBoundArtifact,
        ...serviceReceipt
      } = sourceBoundServiceReceipt;
      return {
        ...serviceReceipt,
        artifact: sourceBoundArtifact && typeof sourceBoundArtifact === 'object' && !Array.isArray(sourceBoundArtifact)
          ? { ...sourceBoundArtifact, output: basename(output) }
          : sourceBoundArtifact,
      };
    })()
    : sourceBoundServiceReceipt;
  return Object.freeze({
    ...rest,
    serviceReceipt: sanitizeServiceReceipt,
    artifact: rest.artifact && typeof rest.artifact === 'object' && !Array.isArray(rest.artifact)
      ? { ...rest.artifact, output: basename(output) }
      : rest.artifact,
  });
}

function sanitizeTextEditReceipt(result, output) {
  const {
    pdf: _pdf,
    find: _find,
    replace: _replace,
    sourceSha256: _sourceSha256,
    serviceReceipt: sourceBoundServiceReceipt,
    ...rest
  } = result;
  const sanitizeServiceReceipt = sourceBoundServiceReceipt && typeof sourceBoundServiceReceipt === 'object' && !Array.isArray(sourceBoundServiceReceipt)
    ? (() => {
      const {
        find: _srFind,
        replace: _srReplace,
        sourceSha256: _srSourceSha256,
        artifact: sourceBoundArtifact,
        ...serviceReceipt
      } = sourceBoundServiceReceipt;
      return {
        ...serviceReceipt,
        artifact: sourceBoundArtifact && typeof sourceBoundArtifact === 'object' && !Array.isArray(sourceBoundArtifact)
          ? { ...sourceBoundArtifact, output: basename(output) }
          : sourceBoundArtifact,
      };
    })()
    : sourceBoundServiceReceipt;
  return Object.freeze({
    ...rest,
    serviceReceipt: sanitizeServiceReceipt,
    artifact: rest.artifact && typeof rest.artifact === 'object' && !Array.isArray(rest.artifact)
      ? { ...rest.artifact, output: basename(output) }
      : rest.artifact,
  });
}

async function runSourceBoundAccessibility(application, command, stdout, signal, runtime) {
  const deliver = application.professionalCapabilities?.deliverSourceBound;
  if (typeof deliver !== 'function') runtime.fail('PROFESSIONAL_ACCESSIBILITY_UNAVAILABLE', 'Source-bound professional accessibility delivery is unavailable.');
  const document = await runtime.uploadPdf(application, command.input, signal);
  const selected = await runtime.readLocalInputBytes(command.requestPath, {
    minimumBytes: 2,
    maximumBytes: 128 * 1024,
    extension: '.json',
    signal,
  });
  let request;
  try {
    request = normalizeSourceBoundAccessibility(command.capabilityId, JSON.parse(selected.bytes.toString('utf8')));
    if (request === null) throw new TypeError('Unsupported source-bound accessibility capability');
  } catch {
    runtime.fail('CLI_INVALID_PROFESSIONAL_ACCESSIBILITY_REQUEST', 'The professional accessibility request file is invalid or outside the bounded contract.');
  } finally {
    selected.bytes.fill(0);
  }
  if (request.sourceSha256 !== document.sha256) runtime.fail('SOURCE_VERSION_MISMATCH', 'The professional accessibility request digest does not match the uploaded source.');
  let artifactId = null;
  let operationError = null;
  try {
    const result = await deliver(
      command.capabilityId,
      document.id,
      request,
      signal === undefined ? {} : { signal },
    );
    artifactId = result?.artifact?.id ?? null;
    runtime.cancelled(signal);
    if (!artifactId) runtime.fail('PROFESSIONAL_ACCESSIBILITY_RECEIPT_INVALID', 'Professional accessibility delivery did not return a retained artifact.');
    const retained = application.store.getArtifact(artifactId);
    if (retained.sha256 !== result.outputSha256 || retained.documentId !== document.id) {
      runtime.fail('PROFESSIONAL_ACCESSIBILITY_RECEIPT_INVALID', 'The retained professional accessibility artifact does not match the validated receipt.');
    }
    await runtime.copyExclusive(retained.filePath, command.output, signal);
    runtime.cancelled(signal);
    const { pdf: _pdf, ...receipt } = result;
    await runtime.emit(stdout, { ...receipt, artifact: { ...receipt.artifact, output: basename(command.output) } });
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  if (artifactId) {
    try { await application.store.deleteArtifact(artifactId); } catch (error) { cleanupError = error; }
  }
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], 'Professional accessibility delivery and artifact cleanup failed.');
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
}

async function runSourceBoundTextEdit(application, command, stdout, signal, runtime) {
  const deliver = application.professionalCapabilities?.deliverTextSourceBound;
  if (typeof deliver !== 'function') runtime.fail('PROFESSIONAL_CONTENT_EDIT_UNAVAILABLE', 'Source-bound professional text-edit delivery is unavailable.');
  const document = await runtime.uploadPdf(application, command.input, signal);
  runtime.cancelled(signal);
  const selected = await runtime.readLocalInputBytes(command.requestPath, {
    minimumBytes: 2,
    maximumBytes: 128 * 1024,
    extension: '.json',
    signal,
  });
  runtime.cancelled(signal);
  let request;
  try {
    request = normalizePdfTextEditRequest(JSON.parse(selected.bytes.toString('utf8')));
  } catch {
    runtime.fail('CLI_INVALID_PROFESSIONAL_CONTENT_EDIT_REQUEST', 'The professional text-edit request file is invalid or outside the bounded contract.');
  } finally {
    selected.bytes.fill(0);
  }
  if (request.sourceSha256 !== document.sha256) {
    runtime.fail('SOURCE_VERSION_MISMATCH', 'The professional text-edit request digest does not match the uploaded source.');
  }
  runtime.cancelled(signal);
  let artifactId = null;
  let operationError = null;
  try {
    const requestForDelivery = {
      page: request.page,
      find: request.find,
      replace: request.replace,
      sourceSha256: request.sourceSha256,
    };
    const result = await deliver(
      command.capabilityId,
      document.id,
      requestForDelivery,
      signal === undefined ? {} : { signal },
    );
    artifactId = result?.artifact?.id ?? null;
    runtime.cancelled(signal);
    if (!artifactId) runtime.fail('PROFESSIONAL_TEXT_EDIT_RECEIPT_INVALID', 'Professional text-edit delivery did not return a retained artifact.');
    const retained = application.store.getArtifact(artifactId);
    if (retained.sha256 !== result.outputSha256 || retained.documentId !== document.id) {
      runtime.fail('PROFESSIONAL_TEXT_EDIT_RECEIPT_INVALID', 'The retained professional text-edit artifact does not match the validated receipt.');
    }
    await runtime.copyExclusive(retained.filePath, command.output, signal);
    runtime.cancelled(signal);
    const receipt = sanitizeTextEditReceipt(result, command.output);
    await runtime.emit(stdout, receipt);
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  if (artifactId) {
    try { await application.store.deleteArtifact(artifactId); } catch (error) { cleanupError = error; }
  }
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], 'Professional text-edit delivery and artifact cleanup failed.');
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
}

async function runSourceBoundMetadataEdit(application, command, stdout, signal, runtime) {
  const deliver = application.professionalCapabilities?.deliverContentEditingSourceBound;
  if (typeof deliver !== 'function') runtime.fail('PROFESSIONAL_METADATA_EDIT_UNAVAILABLE', 'Source-bound professional metadata-edit delivery is unavailable.');
  const document = await runtime.uploadPdf(application, command.input, signal);
  runtime.cancelled(signal);
  const selected = await runtime.readLocalInputBytes(command.requestPath, {
    minimumBytes: 2,
    maximumBytes: 128 * 1024,
    extension: '.json',
    signal,
  });
  runtime.cancelled(signal);
  let request;
  try {
    request = sanitizeMetadataRequest(JSON.parse(selected.bytes.toString('utf8')));
  } catch {
    runtime.fail('CLI_INVALID_PROFESSIONAL_METADATA_REQUEST', 'The professional metadata-edit request file is invalid or outside the bounded contract.');
  } finally {
    selected.bytes.fill(0);
  }
  if (request === null) {
    runtime.fail('CLI_INVALID_PROFESSIONAL_METADATA_REQUEST', 'The professional metadata-edit request file is invalid or outside the bounded contract.');
  }
  if (request.sourceSha256 !== document.sha256) runtime.fail('SOURCE_VERSION_MISMATCH', 'The professional metadata-edit request digest does not match the uploaded source.');
  let artifactId = null;
  let operationError = null;
  try {
    const result = await deliver(
      command.capabilityId,
      document.id,
      request,
      signal === undefined ? {} : { signal },
    );
    artifactId = result?.artifact?.id ?? null;
    runtime.cancelled(signal);
    if (!artifactId) runtime.fail('PROFESSIONAL_METADATA_EDIT_RECEIPT_INVALID', 'Professional metadata-edit delivery did not return a retained artifact.');
    const retained = application.store.getArtifact(artifactId);
    if (retained.sha256 !== result.outputSha256 || retained.documentId !== document.id) {
      runtime.fail('PROFESSIONAL_METADATA_EDIT_RECEIPT_INVALID', 'The retained professional metadata-edit artifact does not match the validated receipt.');
    }
    await runtime.copyExclusive(retained.filePath, command.output, signal);
    runtime.cancelled(signal);
    const receipt = sanitizeMetadataEditReceipt(result, command.output);
    await runtime.emit(stdout, receipt);
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  if (artifactId) {
    try { await application.store.deleteArtifact(artifactId); } catch (error) { cleanupError = error; }
  }
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], 'Professional metadata-edit delivery and artifact cleanup failed.');
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
}

export async function runProfessionalCapabilityCommand(application, command, stdout, signal, runtime) {
  runtime.cancelled(signal);
  const capabilityId = command.capabilityId;
  if (typeof capabilityId !== 'string' || !capabilityId) {
    const error = new Error('capabilityId is required');
    error.code = 'INVALID_CLI_ARGUMENTS';
    throw error;
  }
  const context = command.context && typeof command.context === 'object' ? command.context : {};
  if (Object.hasOwn(SOURCE_BOUND_ACCESSIBILITY, capabilityId)) {
    await runSourceBoundAccessibility(application, command, stdout, signal, runtime);
    return;
  }
  if (SOURCE_BOUND_TEXT_EDIT.has(capabilityId)) {
    await runSourceBoundTextEdit(application, command, stdout, signal, runtime);
    return;
  }
  if (SOURCE_BOUND_METADATA_EDIT.has(capabilityId)) {
    await runSourceBoundMetadataEdit(application, command, stdout, signal, runtime);
    return;
  }
  if (SOURCE_BOUND_PAGE_ORGANIZATION.has(capabilityId)) {
    await runSourceBoundPageOrganization(application, command, stdout, signal, runtime);
    return;
  }
  if (SOURCE_BOUND_HEADER_FOOTER_EDIT.has(capabilityId)) {
    await runSourceBoundHeaderFooterEdit(application, command, stdout, signal, runtime);
    return;
  }
  const deliver = application.professionalCapabilities?.deliver;
  if (typeof deliver !== 'function') {
    const error = new Error('Professional capability delivery is unavailable');
    error.code = 'PROFESSIONAL_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const result = await deliver(capabilityId, { ...context, signal });
  // Do not dump raw PDF bytes to stdout
  const { pdf, ...rest } = result;
  await runtime.outputValue(command, stdout, pdf ? { ...rest, pdfBytes: pdf.length, hasPdf: true } : rest);
}
