import { HostError } from '../host-error.mjs';
import { PDF_ATTACHMENT_REMOVAL_PROFILE } from '../pdf-attachment-removal-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

export async function handleAttachmentRemovalRoute(context) {
  if (context.operation !== 'attachment-removal') return false;
  const {
    request, response, url, documentId, processing, store, attachmentRemoval,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError(
      'INVALID_PARAMETER',
      'Attachment removal does not accept query parameters.',
      400,
    );
  }
  if (!attachmentRemoval) {
    throw new HostError(
      'ATTACHMENT_REMOVAL_UNAVAILABLE',
      'The local attachment-removal service is unavailable.',
      503,
    );
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256'])
    || body.profile !== PDF_ATTACHMENT_REMOVAL_PROFILE
    || !/^[0-9a-f]{64}$/.test(body.sourceSha256)) {
    throw new HostError(
      'INVALID_ATTACHMENT_REMOVAL_OPTIONS',
      'Attachment removal requires the fixed profile and lowercase source SHA-256.',
      400,
    );
  }
  const result = await attachmentRemoval.remove(
    documentId,
    { profile: body.profile },
    { sourceSha256: body.sourceSha256, signal: processing.signal },
  );
  if (await scheduleArtifactCleanup(
    { processing, response, store },
    result.artifact.id,
  )) return true;
  json(response, 201, { result });
  return true;
}
