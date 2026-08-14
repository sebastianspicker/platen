import { HostError } from '../host-error.mjs';
import { FULL_PAGE_REDACTION_BATCH_PROFILE, FULL_PAGE_REDACTION_PROFILE } from '../pdf-full-page-redaction-writer.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

function validFullPageRedactionBody(body, exactJsonObject) {
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'page'])) return false;
  if (body.profile !== FULL_PAGE_REDACTION_PROFILE) return false;
  return SHA256.test(body.sourceSha256);
}

function validPage(page) {
  if (!Number.isSafeInteger(page)) return false;
  if (page < 1) return false;
  return page <= 100;
}

function bodyHasValidPage(body) {
  if (!Number.isSafeInteger(body.page)) return false;
  if (body.page < 1) return false;
  return body.page <= 100;
}

function bodyHasInvalidBatchPage(body) {
  return body.pages.some((page) => !validPage(page));
}

function bodyHasOutOfOrderBatchPage(body) {
  return body.pages.some((page, index) => {
    if (index === 0) return false;
    return page <= body.pages[index - 1];
  });
}

function validBatchPages(body) {
  if (!Array.isArray(body.pages)) return false;
  if (body.pages.length < 1) return false;
  if (body.pages.length > 32) return false;
  if (bodyHasInvalidBatchPage(body)) return false;
  return !bodyHasOutOfOrderBatchPage(body);
}

function validFullPageRedactionBatchBody(body, exactJsonObject) {
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'pages'])) return false;
  if (body.profile !== FULL_PAGE_REDACTION_BATCH_PROFILE) return false;
  if (!SHA256.test(body.sourceSha256)) return false;
  return validBatchPages(body);
}

function requireFullPageRedactionBody(body, exactJsonObject) {
  if (!validFullPageRedactionBody(body, exactJsonObject)) {
    throw new HostError('INVALID_FULL_PAGE_REDACTION_OPTIONS', 'Full-page redaction requires the fixed profile, current lowercase source SHA-256, and page.', 400);
  }
  if (!bodyHasValidPage(body)) throw new HostError('INVALID_FULL_PAGE_REDACTION_OPTIONS', 'Full-page redaction requires one page from 1 through 100.', 400);
}

function requireFullPageRedactionBatchBody(body, exactJsonObject) {
  if (!validFullPageRedactionBatchBody(body, exactJsonObject)) {
    throw new HostError('INVALID_FULL_PAGE_REDACTION_BATCH_OPTIONS', 'Full-page redaction batch requires the fixed profile, current lowercase source SHA-256, and unique ascending pages.', 400);
  }
}

function singleServiceAvailable(service) {
  return Boolean(service);
}

function batchServiceAvailable(service) {
  return Boolean(service) && typeof service.updateBatch === 'function';
}

function executeRedaction(context, serviceMethod, payloadKey) {
  const {
    body, documentId, processing, fullPageRedaction,
  } = context;
  return fullPageRedaction[serviceMethod](documentId, {
    profile: body.profile, sourceSha256: body.sourceSha256, [payloadKey]: body[payloadKey],
  }, { sourceSha256: body.sourceSha256, signal: processing.signal });
}

function executeSingleRedaction(context) {
  return executeRedaction(context, 'update', 'page');
}

function executeBatchRedaction(context) {
  return executeRedaction(context, 'updateBatch', 'pages');
}

const SINGLE_ROUTE = Object.freeze({
  operation: 'full-page-redaction',
  queryMessage: 'Full-page redaction does not accept query parameters.',
  unavailableMessage: 'The local full-page redaction service is unavailable.',
  serviceAvailable: singleServiceAvailable,
  requireBody: requireFullPageRedactionBody,
  execute: executeSingleRedaction,
});

const BATCH_ROUTE = Object.freeze({
  operation: 'full-page-redaction-batch',
  queryMessage: 'Full-page redaction batch does not accept query parameters.',
  unavailableMessage: 'The local full-page redaction batch service is unavailable.',
  serviceAvailable: batchServiceAvailable,
  requireBody: requireFullPageRedactionBatchBody,
  execute: executeBatchRedaction,
});

async function handleConfiguredFullPageRedactionRoute(context, route) {
  if (context.operation !== route.operation) return false;
  const {
    request, response, url, documentId, processing, fullPageRedaction,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', route.queryMessage, 400);
  }
  if (!route.serviceAvailable(fullPageRedaction)) {
    throw new HostError('FULL_PAGE_REDACTION_UNAVAILABLE', route.unavailableMessage, 503);
  }
  const body = await readJson(request, bodyLimit);
  route.requireBody(body, exactJsonObject);
  const result = await route.execute({ body, documentId, processing, fullPageRedaction });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}

export async function handleFullPageRedactionRoute(context) {
  return handleConfiguredFullPageRedactionRoute(context, SINGLE_ROUTE);
}

export async function handleFullPageRedactionBatchRoute(context) {
  return handleConfiguredFullPageRedactionRoute(context, BATCH_ROUTE);
}
