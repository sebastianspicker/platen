import { sanitizeInsertBlankReceipt, sanitizePageBoxesReceipt } from './professional-page-boxes-receipt.mjs';

const PAGE_BOX_TYPES = Object.freeze(new Set(['crop', 'bleed']));

function sanitizePageBoxesRequest(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !keys.every((key) => key === 'sourceSha256' || key === 'page' || key === 'boxType' || key === 'box')) {
    return null;
  }
  const { sourceSha256, page, boxType, box } = value;
  if (typeof sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sourceSha256)) return null;
  if (!Number.isSafeInteger(page) || page < 1) return null;
  if (typeof boxType !== 'string' || !PAGE_BOX_TYPES.has(boxType)) return null;
  if (!box || Object.getPrototypeOf(box) !== Object.prototype || Array.isArray(box)) return null;
  const boxKeys = Object.keys(box);
  if (boxKeys.length !== 4 || !boxKeys.every((key) => key === 'left' || key === 'bottom' || key === 'right' || key === 'top')) {
    return null;
  }
  const { left, bottom, right, top } = box;
  if (!Number.isFinite(left) || !Number.isFinite(bottom) || !Number.isFinite(right) || !Number.isFinite(top)
    || right <= left || top <= bottom) {
    return null;
  }
  return Object.freeze({
    sourceSha256,
    page,
    boxType,
    box: Object.freeze({ left, bottom, right, top }),
  });
}

function sanitizeInsertBlankRequest(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Array.isArray(value)
    || Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !Object.hasOwn(descriptors, 'sourceSha256') || !Object.hasOwn(descriptors, 'afterPage')
    || keys.some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) return null;
  const sourceSha256 = descriptors.sourceSha256.value;
  const afterPage = descriptors.afterPage.value;
  if (typeof sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sourceSha256)
    || !Number.isSafeInteger(afterPage) || afterPage < 1) return null;
  return Object.freeze({ sourceSha256, afterPage });
}

export async function runSourceBoundPageOrganization(application, command, stdout, signal, runtime) {
  const deliver = application.professionalCapabilities?.deliverPageOrganizationSourceBound;
  if (typeof deliver !== 'function') runtime.fail('PROFESSIONAL_PAGE_ORGANIZATION_UNAVAILABLE', 'Source-bound page-organization delivery is unavailable.');
  const insertBlank = command.capabilityId === 'pages.insert-blank';
  const invalidRequestCode = insertBlank
    ? 'CLI_INVALID_PROFESSIONAL_PAGE_ORGANIZATION_REQUEST'
    : 'CLI_INVALID_PROFESSIONAL_PAGE_BOXES_REQUEST';
  const receiptInvalidCode = insertBlank
    ? 'PROFESSIONAL_PAGE_ORGANIZATION_RECEIPT_INVALID'
    : 'PROFESSIONAL_PAGE_BOXES_RECEIPT_INVALID';
  const document = await runtime.uploadPdf(application, command.input, signal);
  runtime.cancelled(signal);
  const selected = await runtime.readLocalInputBytes(command.requestPath, {
    minimumBytes: 2,
    maximumBytes: 128 * 1024,
    extension: '.json',
    signal,
  });
  let request;
  try {
    const parsed = JSON.parse(selected.bytes.toString('utf8'));
    request = insertBlank
      ? sanitizeInsertBlankRequest(parsed)
      : sanitizePageBoxesRequest(parsed);
  } catch {
    runtime.fail(invalidRequestCode, 'The professional page-organization request file is invalid or outside the bounded contract.');
  } finally {
    selected.bytes.fill(0);
  }
  if (request === null) {
    runtime.fail(invalidRequestCode, 'The professional page-organization request file is invalid or outside the bounded contract.');
  }
  if (request.sourceSha256 !== document.sha256) runtime.fail('SOURCE_VERSION_MISMATCH', 'The professional page-organization request digest does not match the uploaded source.');
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
    if (!artifactId) runtime.fail(receiptInvalidCode, 'Professional page-organization delivery did not return a retained artifact.');
    const retained = application.store.getArtifact(artifactId);
    if (retained.sha256 !== result.outputSha256 || retained.documentId !== document.id) {
      runtime.fail(receiptInvalidCode, 'The retained professional page-organization artifact does not match the validated receipt.');
    }
    await runtime.copyExclusive(retained.filePath, command.output, signal);
    runtime.cancelled(signal);
    const receipt = insertBlank
      ? sanitizeInsertBlankReceipt(result, command.output)
      : sanitizePageBoxesReceipt(result, command.output);
    await runtime.emit(stdout, receipt);
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  if (artifactId) {
    try { await application.store.deleteArtifact(artifactId); } catch (error) { cleanupError = error; }
  }
  if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], 'Professional page-organization delivery and artifact cleanup failed.');
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
}
