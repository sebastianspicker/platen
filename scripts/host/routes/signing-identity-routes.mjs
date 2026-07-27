import { HostError } from '../host-error.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';
import { PDF_SIGNATURE_CONTAINER_PROFILE } from '../pdf-signature-container-writer.mjs';

export async function handleSigningIdentityListRoute({ pathname, request, response, url, signingIdentityDirectory, signingIdentityReady, processing, method, json }) {
  if (pathname !== '/api/signing-identities') return false;
  method(request, 'GET');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Signing identity listing does not accept query parameters.', 400);
  if (!signingIdentityReady || !signingIdentityDirectory) throw new HostError('SIGNING_IDENTITY_UNAVAILABLE', 'The staged signing identity helper is unavailable.', 503);
  let identities;
  try { identities = await signingIdentityDirectory.list({ signal: processing.signal }); }
  catch (error) {
    if (processing.signal.aborted || error?.code === 'ENGINE_CANCELLED') throw new HostError('JOB_CANCELLED', 'Signing identity listing was cancelled.', 499, { cause: error });
    if (error?.code === 'SIGNING_IDENTITY_PLATFORM_DENIED') throw new HostError('SIGNING_IDENTITY_PLATFORM_DENIED', 'The platform refused access to local signing identities.', 502, { cause: error });
    throw new HostError('SIGNING_IDENTITY_FAILED', 'The local signing identity helper failed its bounded contract.', 502, { cause: error });
  }
  json(response, 200, { identities });
  return true;
}

export async function handleCertificateSignRoute({ request, response, url, documentId, operation, processing, store, certificateSignature, signingIdentityReady, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== 'certificate-sign') return false;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Certificate signing does not accept query parameters.', 400);
  if (!signingIdentityReady || !certificateSignature) throw new HostError('CERTIFICATE_SIGNATURE_UNAVAILABLE', 'The staged signing identity helper is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'certificateSha256', 'page', 'fieldName', 'reason', 'location', 'contact', 'placeholderBytes']) || body.profile !== PDF_SIGNATURE_CONTAINER_PROFILE || !/^[0-9a-f]{64}$/u.test(body.sourceSha256) || !/^[0-9a-f]{64}$/u.test(body.certificateSha256)) throw new HostError('INVALID_CERTIFICATE_SIGNATURE_REQUEST', 'Certificate signing requires the fixed profile, current source digest, certificate digest, page, and bounded metadata.', 400);
  const { certificateSha256, ...requestValue } = body;
  const result = await certificateSignature.sign(documentId, requestValue, { certificateSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup({ processing, response, store }, result.artifact.id)) return true;
  json(response, 201, { result }); return true;
}
