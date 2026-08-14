import { OPAQUE_ID } from '../document-store-contract.mjs';
import { HostError } from '../host-error.mjs';
import { PDF_COPY_PAGE_PROFILE } from '../pdf-copy-page-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const BODY_FIELDS = Object.freeze([
  'profile',
  'primarySourceSha256',
  'secondaryDocumentId',
  'secondarySourceSha256',
  'sourcePage',
  'afterPage',
]);

export async function handleCopyPageRoute(context) {
  if (context.operation !== 'copy-page') return false;
  const {
    request, response, url, documentId, processing, service, store,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError(
      'INVALID_PARAMETER',
      'Cross-document page copying does not accept query parameters.',
      400,
    );
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, BODY_FIELDS)
    || body.profile !== PDF_COPY_PAGE_PROFILE
    || !SHA256.test(body.primarySourceSha256 ?? '')
    || !OPAQUE_ID.test(body.secondaryDocumentId ?? '')
    || !SHA256.test(body.secondarySourceSha256 ?? '')
    || !Number.isSafeInteger(body.sourcePage)
    || !Number.isSafeInteger(body.afterPage)) {
    throw new HostError(
      'INVALID_COPY_PAGE_REQUEST',
      'Cross-document page copying requires the fixed profile, two source bindings, and integer page positions.',
      400,
    );
  }
  const artifact = await service.copyPageBetweenDocuments(
    documentId,
    body.secondaryDocumentId,
    {
      profile: body.profile,
      primarySourceSha256: body.primarySourceSha256,
      secondarySourceSha256: body.secondarySourceSha256,
      sourcePage: body.sourcePage,
      afterPage: body.afterPage,
    },
    { signal: processing.signal },
  );
  if (await scheduleArtifactCleanup({ processing, response, store }, artifact.id)) return true;
  json(response, 201, { artifact });
  return true;
}
