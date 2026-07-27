import { HostError } from '../host-error.mjs';
import {
  ANNOTATION_FLATTEN_PROFILE,
  normalizeAnnotationFlatten,
} from '../pdf-annotation-flatten-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

export async function handleAnnotationFlattenRoute(context) {
  if (context.operation !== 'annotation-flatten') return false;
  const {
    request, response, url, documentId, processing, store, annotationFlatten,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) {
    throw new HostError(
      'INVALID_PARAMETER',
      'Annotation flattening does not accept query parameters.',
      400,
    );
  }
  if (!annotationFlatten) {
    throw new HostError(
      'ANNOTATION_FLATTEN_UNAVAILABLE',
      'The local annotation-flatten service is unavailable.',
      503,
    );
  }
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'target'])
    || body.profile !== ANNOTATION_FLATTEN_PROFILE
    || !SHA256.test(body.sourceSha256 ?? '')
    || !exactJsonObject(body.target, ['page', 'annotationIndex', 'fingerprint', 'subtype'])) {
    throw new HostError(
      'INVALID_ANNOTATION_FLATTEN_OPTIONS',
      'Annotation flattening requires the fixed profile, lowercase source SHA-256, and one exact source-bound square annotation target.',
      400,
    );
  }
  let value;
  try {
    value = normalizeAnnotationFlatten({
      profile: body.profile,
      sourceSha256: body.sourceSha256,
      target: {
        page: body.target.page,
        annotationIndex: body.target.annotationIndex,
        fingerprint: body.target.fingerprint,
        subtype: body.target.subtype,
      },
    });
  } catch {
    throw new HostError(
      'INVALID_ANNOTATION_FLATTEN_OPTIONS',
      'The source-bound square annotation target is invalid.',
      400,
    );
  }
  const result = await annotationFlatten.flatten(documentId, value, {
    sourceSha256: body.sourceSha256,
    signal: processing.signal,
  });
  if (await scheduleArtifactCleanup(
    { processing, response, store }, result.artifact.id,
  )) return true;
  json(response, 201, { result });
  return true;
}
