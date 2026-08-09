import { HostError } from '../host-error.mjs';
import {
  COMMENTS_TO_OFFICE_PROFILE,
  validateCommentsToOfficeResult,
} from '../../../src/core/local-host-comments-to-office-endpoints.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_RECORDS = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function validSelectedIds(value) {
  return value === null || (Array.isArray(value) && value.length >= 1 && value.length <= MAX_RECORDS
    && Object.keys(value).length === value.length
    && value.every((id) => typeof id === 'string' && ID.test(id))
    && new Set(value).size === value.length);
}

async function revokeCandidate(store, result, documentId, sourceSha256) {
  if (typeof result?.artifact?.id !== 'string' || typeof store?.getArtifact !== 'function'
    || typeof store.deleteArtifact !== 'function') return;
  let retained;
  try { retained = await store.getArtifact(result.artifact.id); } catch { return; }
  const sourceInput = retained?.operation?.inputs?.find((input) => input?.role === 'source');
  if (retained?.id !== result.artifact.id || retained.documentId !== documentId
    || retained.operation?.type !== 'comments-to-office'
    || sourceInput?.documentId !== documentId || sourceInput?.sha256 !== sourceSha256) return;
  await store.deleteArtifact(retained.id).catch(() => {});
}

export async function handleCommentsToOfficeRoute(context) {
  if (context.operation !== 'comments-to-office') return false;
  const {
    request, response, url, documentId, processing, store, commentsToOffice,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Comments-to-Office export does not accept query parameters.', 400);
  }
  if (!commentsToOffice || typeof commentsToOffice.export !== 'function') {
    throw new HostError('COMMENTS_TO_OFFICE_UNAVAILABLE', 'The local comments-to-Office service is unavailable.', 503);
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'revision', 'selectedIds'])
    || body.profile !== COMMENTS_TO_OFFICE_PROFILE
    || !SHA256.test(body.sourceSha256 ?? '')
    || !Number.isSafeInteger(body.revision) || body.revision < 0
    || !validSelectedIds(body.selectedIds)) {
    throw new HostError(
      'INVALID_COMMENTS_TO_OFFICE_OPTIONS',
      'Comments-to-Office export requires the fixed profile, current lowercase source SHA-256, workspace revision, and selected IDs.',
      400,
    );
  }

  const requestBody = {
    sourceSha256: body.sourceSha256,
    revision: body.revision,
    selectedIds: body.selectedIds === null ? null : [...body.selectedIds],
  };
  let result;
  try {
    result = await commentsToOffice.export(documentId, requestBody, { signal: processing.signal });
    validateCommentsToOfficeResult(result, {
      documentId,
      sourceSha256: body.sourceSha256,
      request: requestBody,
    });
  } catch (error) {
    if (error?.code === 'INVALID_LOCAL_HOST') {
      await revokeCandidate(store, result, documentId, body.sourceSha256);
      throw new HostError('COMMENTS_TO_OFFICE_RESULT_INVALID', 'The comments-to-Office service returned invalid source-bound evidence.', 502, { cause: error });
    }
    throw error;
  }

  if (processing.signal.aborted || response.destroyed) {
    await revokeCandidate(store, result, documentId, body.sourceSha256);
    return true;
  }
  let delivered = false;
  response.once('finish', () => { delivered = true; });
  response.once('close', () => {
    if (!delivered) void revokeCandidate(store, result, documentId, body.sourceSha256);
  });
  json(response, 201, { result });
  return true;
}
