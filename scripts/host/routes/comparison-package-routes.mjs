import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HostError } from '../host-error.mjs';
import { COMPARISON_PACKAGE_PROFILE } from '../comparison-package-service.mjs';
import { validateComparisonPackage } from '../comparison-package-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const BODY_LIMIT = 2_048;
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function validBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.getPrototypeOf(body) !== Object.prototype) return false;
  const keys = Object.keys(body);
  const expected = body.includeVisual === true
    ? ['profile', 'revisionDocumentId', 'primarySha256', 'revisionSha256', 'includeVisual', 'dpi']
    : ['profile', 'revisionDocumentId', 'primarySha256', 'revisionSha256', 'includeVisual'];
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
    && body.profile === COMPARISON_PACKAGE_PROFILE
    && typeof body.revisionDocumentId === 'string' && body.revisionDocumentId.length >= 1
    && SHA256.test(body.primarySha256 ?? '') && SHA256.test(body.revisionSha256 ?? '')
    && typeof body.includeVisual === 'boolean'
    && (body.includeVisual === false || (Number.isSafeInteger(body.dpi) && body.dpi >= 36 && body.dpi <= 240));
}

export async function handleComparisonPackageRoute(context) {
  const { request, response, url, documentId, operation, processing, store,
    comparisonPackages, method, readJson, json } = context;
  if (operation !== 'comparison-package') return false;
  method(request, 'POST');
  if (url.search !== '') throw new HostError('INVALID_COMPARISON_PACKAGE_REQUEST', 'Comparison packages do not accept query parameters.', 400);
  if (!comparisonPackages) throw new HostError('COMPARISON_PACKAGE_UNAVAILABLE', 'Comparison package creation is unavailable.', 503);
  const body = await readJson(request, BODY_LIMIT);
  if (!validBody(body) || body.revisionDocumentId === documentId) {
    throw new HostError('INVALID_COMPARISON_PACKAGE_REQUEST', 'Comparison packages require two distinct current local PDF sources.', 400);
  }
  const result = await comparisonPackages.create(documentId, body.revisionDocumentId, {
    primarySha256: body.primarySha256,
    revisionSha256: body.revisionSha256,
    includeVisual: body.includeVisual,
    ...(body.includeVisual ? { dpi: body.dpi } : {}),
    signal: processing.signal,
  });
  if (result.sourceDigests?.primary !== body.primarySha256
    || result.sourceDigests?.revision !== body.revisionSha256
    || result.artifact?.documentId !== documentId) {
    if (typeof result.artifact?.id === 'string') await store.deleteArtifact(result.artifact.id);
    throw new HostError('COMPARISON_PACKAGE_RESULT_INVALID', 'Comparison package evidence does not match the requested sources.', 502);
  }
  const retained = store.getArtifact(result.artifact.id);
  let retainedBytes;
  try { retainedBytes = await readFile(retained.filePath); } catch (error) {
    await store.deleteArtifact(result.artifact.id);
    throw new HostError('COMPARISON_PACKAGE_RESULT_INVALID', 'The retained comparison package could not be reread.', 502, { cause: error });
  }
  try {
    validateComparisonPackage(retainedBytes, body.primarySha256, body.revisionSha256);
    if (retained.id !== result.artifact.id || retained.documentId !== documentId
      || retained.size !== retainedBytes.length || retained.size !== result.artifact.size
      || retained.sha256 !== digest(retainedBytes)
      || retained.sha256 !== result.artifact.sha256) throw new Error('retained artifact identity mismatch');
  } catch (error) {
    await store.deleteArtifact(result.artifact.id);
    throw new HostError('COMPARISON_PACKAGE_RESULT_INVALID', 'The retained comparison package failed independent validation.', 502, { cause: error });
  } finally { retainedBytes.fill(0); }
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
