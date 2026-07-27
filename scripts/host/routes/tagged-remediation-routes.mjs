import { HostError } from '../host-error.mjs';
import { TAGGED_PDF_REMEDIATION_PROFILE, normalizeTaggedPdfRemediationRequest } from '../pdf-tagged-remediation-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';
export async function handleTaggedRemediationRoute({ request, response, url, documentId, operation, processing, store, taggedRemediation, taggedRemediationReady, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== 'tagged-remediation') return false;
  method(request, 'POST'); if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Tagged remediation does not accept query parameters.', 400);
  if (!taggedRemediationReady || !taggedRemediation) throw new HostError('TAGGED_PDF_REMEDIATION_UNAVAILABLE', 'Tagged-PDF remediation is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'plan', 'language', 'title', 'roleMap']) || body.profile !== TAGGED_PDF_REMEDIATION_PROFILE || !/^[a-f0-9]{64}$/u.test(body.sourceSha256)) throw new HostError('INVALID_TAGGED_PDF_REMEDIATION_OPTIONS', 'Tagged remediation requires the fixed profile, current source digest, and explicit bounded semantic plan.', 400);
  try { normalizeTaggedPdfRemediationRequest(body); } catch (error) { throw new HostError('INVALID_TAGGED_PDF_REMEDIATION_OPTIONS', 'Tagged remediation requires an explicit bounded semantic plan.', 400, { cause: error }); }
  const result = await taggedRemediation.update(documentId, body, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result }); return true;
}
