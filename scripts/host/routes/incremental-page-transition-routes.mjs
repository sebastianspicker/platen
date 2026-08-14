import { HostError } from '../host-error.mjs';
import {
  INCREMENTAL_PAGE_TRANSITION_PROFILE,
  normalizeIncrementalPageTransition,
} from '../pdf-incremental-page-transition-contract.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

function sha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value); }

export async function handleIncrementalPageTransitionRoute(context) {
  if (context.operation !== 'incremental-page-transition') return false;
  const {
    request, response, url, documentId, processing, incrementalPageTransition,
    bodyLimit, exactJsonObject, method, readJson, json,
  } = context;
  method(request, 'POST');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Incremental page-transition editing does not accept query parameters.', 400);
  if (!incrementalPageTransition) throw new HostError('INCREMENTAL_PAGE_TRANSITION_UNAVAILABLE', 'The local incremental page-transition service is unavailable.', 503);
  const body = await readJson(request, bodyLimit);
  if (!exactJsonObject(body, ['profile', 'sourceSha256', 'pages', 'transition', 'duration'])
    || body.profile !== INCREMENTAL_PAGE_TRANSITION_PROFILE || !sha256(body.sourceSha256)) {
    throw new HostError('INVALID_INCREMENTAL_PAGE_TRANSITION_OPTIONS', 'Incremental page transitions require the fixed profile, current lowercase source SHA-256, pages, Dissolve transition, and duration.', 400);
  }
  let value;
  try {
    value = normalizeIncrementalPageTransition({
      profile: body.profile, pages: body.pages, transition: body.transition, duration: body.duration,
    });
  } catch {
    throw new HostError('INVALID_INCREMENTAL_PAGE_TRANSITION_OPTIONS', 'Incremental page transitions require valid ascending pages, Dissolve, and bounded duration.', 400);
  }
  const result = await incrementalPageTransition.update(documentId, value, { sourceSha256: body.sourceSha256, signal: processing.signal });
  if (await scheduleArtifactCleanup(context, result.artifact.id)) return true;
  json(response, 201, { result });
  return true;
}
