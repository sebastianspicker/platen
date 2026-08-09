import { HostError } from '../host-error.mjs';
import { scheduleArtifactCleanup } from './artifact-response-lifecycle.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const PAGE_OPERATION_METHODS = Object.freeze({
  extract: 'extractPages',
  arrange: 'arrangePages',
  duplicate: 'duplicatePages',
});
const SECONDARY_OPERATION_ERRORS = Object.freeze({
  merge: ['INVALID_MERGE', 'A secondary local document identifier is required.'],
  interleave: ['INVALID_INTERLEAVE', 'A secondary local document identifier is required.'],
  insert: ['INVALID_INSERT', 'A secondary local document identifier is required.'],
  replace: ['INVALID_REPLACE', 'A replacement local document identifier is required.'],
});

function abort(signal) {
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'The page-composition request was cancelled.', 499);
}

function exactBody(context, body, keys) {
  if (!context.exactJsonObject(body, keys)) {
    throw new HostError('INVALID_COMPOSITION_REQUEST', 'Page composition requires its exact source-bound request fields.', 400);
  }
  return body;
}

function queryFree(url) {
  if ([...url.searchParams].length) {
    throw new HostError('INVALID_PARAMETER', 'Page composition does not accept query parameters.', 400);
  }
}

async function sourceBinding(store, documentId, sourceSha256, label) {
  if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function'
    || typeof store.deleteArtifact !== 'function') {
    throw new HostError('COMPOSITION_SERVICE_UNAVAILABLE', 'Page composition requires the local document store.', 503);
  }
  if (typeof documentId !== 'string' || documentId.length < 1 || !SHA256.test(sourceSha256 ?? '')) {
    throw new HostError('INVALID_COMPOSITION_REQUEST', `${label} source binding is invalid.`, 400);
  }
  const source = store.getDocument(documentId);
  if (source.sha256 !== sourceSha256) {
    throw new HostError('SOURCE_VERSION_MISMATCH', `${label} source digest does not match the current document.`, 409);
  }
  try {
    await store.verifySource(documentId);
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError('COMPOSITION_SOURCE_INTEGRITY_FAILED', `${label} source integrity could not be verified.`, 502, { cause: error });
  }
  return source;
}

function artifactList(value, multiple) {
  const artifacts = multiple ? value : [value];
  if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > 100
    || artifacts.some((artifact) => !artifact || typeof artifact.id !== 'string' || artifact.id.length < 1)
    || new Set(artifacts.map(({ id }) => id)).size !== artifacts.length) {
    throw new HostError('COMPOSITION_OUTPUT_INVALID', 'Page composition returned an invalid retained-artifact receipt.', 502);
  }
  return artifacts;
}

async function revokeArtifacts(store, artifacts, cause) {
  const failures = [];
  for (const artifact of artifacts) {
    try {
      await store.deleteArtifact(artifact.id);
    } catch (error) {
      if (error?.code !== 'ARTIFACT_NOT_FOUND') failures.push(error);
    }
  }
  if (failures.length) {
    throw new HostError('COMPOSITION_ROUTE_CLEANUP_FAILED', 'Page composition could not revoke every undelivered artifact.', 500, {
      cause: new AggregateError([cause, ...failures].filter(Boolean)),
    });
  }
}

async function scheduleArtifacts(context, artifacts) {
  const scheduled = [];
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    try {
      if (await scheduleArtifactCleanup(context, artifact.id)) {
        await revokeArtifacts(context.store, [...scheduled, ...artifacts.slice(index + 1)]);
        return true;
      }
    } catch (error) {
      await revokeArtifacts(context.store, artifacts, error);
      throw error;
    }
    scheduled.push(artifact);
  }
  return false;
}

async function publish(context, value, { multiple = false } = {}) {
  const artifacts = artifactList(value, multiple);
  try {
    abort(context.processing.signal);
    await Promise.all(context.sourceIds.map((documentId) => context.store.verifySource(documentId)));
  } catch (error) {
    await revokeArtifacts(context.store, artifacts, error);
    throw error;
  }
  if (await scheduleArtifacts({
    processing: context.processing,
    response: context.response,
    store: context.store,
  }, artifacts)) return true;
  context.json(context.response, 201, multiple ? { artifacts } : { artifact: artifacts[0] });
  return true;
}

export async function handleDocumentMutationRoute(context) {
  queryFree(context.url);
  const { operation } = context;
  if (PAGE_OPERATION_METHODS[operation]) return mutatePages(context);
  if (operation === 'delete') return deletePages(context);
  if (operation === 'split') return splitDocument(context);
  if (operation === 'split-rule') return splitDocumentByRule(context);
  if (operation === 'reverse') return reverseDocument(context);
  return combineDocuments(context);
}

async function oneSourceRequest(context, keys) {
  const body = exactBody(context, await context.readJson(context.request), ['sourceSha256', ...keys]);
  await sourceBinding(context.store, context.documentId, body.sourceSha256, 'Primary');
  abort(context.processing.signal);
  return body;
}

async function mutatePages(context) {
  context.method(context.request, 'POST');
  const body = await oneSourceRequest(context, ['pages']);
  const artifact = await context.service[PAGE_OPERATION_METHODS[context.operation]](
    context.documentId,
    body.pages,
    { ...context.processing, sourceSha256: body.sourceSha256 },
  );
  return publish({ ...context, sourceIds: [context.documentId] }, artifact);
}

async function deletePages(context) {
  context.method(context.request, 'POST');
  const body = await oneSourceRequest(context, ['pages']);
  if (!Array.isArray(body.pages) || body.pages.length < 1 || body.pages.length > 500
    || body.pages.some((page) => !Number.isSafeInteger(page) || page < 1)
    || new Set(body.pages).size !== body.pages.length) {
    throw new HostError('INVALID_PAGES', 'Delete pages must be unique positive page numbers.', 400);
  }
  const inspection = await context.service.inspect(context.documentId, context.processing);
  if (!Number.isSafeInteger(inspection?.pageCount) || inspection.pageCount < 1
    || body.pages.some((page) => page > inspection.pageCount)) {
    throw new HostError('INVALID_PAGES', 'Delete pages are outside the source document.', 400);
  }
  const removed = new Set(body.pages);
  const keep = Array.from({ length: inspection.pageCount }, (_, index) => index + 1)
    .filter((page) => !removed.has(page));
  if (!keep.length) throw new HostError('INVALID_PAGES', 'Delete must retain at least one source page.', 400);
  const artifact = await context.service.arrangePages(
    context.documentId,
    keep,
    { ...context.processing, sourceSha256: body.sourceSha256 },
  );
  return publish({ ...context, sourceIds: [context.documentId] }, artifact);
}

async function splitDocument(context) {
  context.method(context.request, 'POST');
  const body = await oneSourceRequest(context, []);
  const artifacts = await context.service.splitDocument(
    context.documentId,
    { ...context.processing, sourceSha256: body.sourceSha256 },
  );
  return publish({ ...context, sourceIds: [context.documentId] }, artifacts, { multiple: true });
}

async function splitDocumentByRule(context) {
  context.method(context.request, 'POST');
  const body = await oneSourceRequest(context, ['pagesPerOutput']);
  const pagesPerOutput = context.parsePositiveInteger(body.pagesPerOutput, 'pagesPerOutput', { maximum: 500 });
  const artifacts = await context.service.splitByPageCount(
    context.documentId,
    pagesPerOutput,
    { ...context.processing, sourceSha256: body.sourceSha256 },
  );
  return publish({ ...context, sourceIds: [context.documentId] }, artifacts, { multiple: true });
}

async function reverseDocument(context) {
  context.method(context.request, 'POST');
  const body = await oneSourceRequest(context, []);
  const artifact = await context.service.reversePages(
    context.documentId,
    { ...context.processing, sourceSha256: body.sourceSha256 },
  );
  return publish({ ...context, sourceIds: [context.documentId] }, artifact);
}

async function combineDocuments(context) {
  const {
    request, documentId, operation, processing, service, method, parsePositiveInteger,
  } = context;
  method(request, 'POST');
  const extraKeys = operation === 'insert' ? ['afterPage'] : operation === 'replace' ? ['startPage', 'endPage'] : [];
  const body = exactBody(context, await context.readJson(request), [
    'primarySourceSha256', 'secondaryDocumentId', 'secondarySourceSha256', ...extraKeys,
  ]);
  if (typeof body.secondaryDocumentId !== 'string' || body.secondaryDocumentId === documentId) {
    throw new HostError(...SECONDARY_OPERATION_ERRORS[operation], 400);
  }
  await Promise.all([
    sourceBinding(context.store, documentId, body.primarySourceSha256, 'Primary'),
    sourceBinding(context.store, body.secondaryDocumentId, body.secondarySourceSha256, 'Secondary'),
  ]);
  abort(processing.signal);
  const options = {
    ...processing,
    primarySourceSha256: body.primarySourceSha256,
    secondarySourceSha256: body.secondarySourceSha256,
  };
  let artifact;
  if (operation === 'merge') artifact = await service.mergeDocuments(documentId, body.secondaryDocumentId, options);
  else if (operation === 'interleave') artifact = await service.interleaveDocuments(documentId, body.secondaryDocumentId, options);
  else if (operation === 'insert') {
    const afterPage = parsePositiveInteger(body.afterPage, 'afterPage', { minimum: 0, maximum: 1_000_000 });
    artifact = await service.insertDocument(documentId, body.secondaryDocumentId, afterPage, options);
  } else {
    const startPage = parsePositiveInteger(body.startPage, 'startPage');
    const endPage = parsePositiveInteger(body.endPage, 'endPage');
    artifact = await service.replacePages(documentId, body.secondaryDocumentId, startPage, endPage, options);
  }
  return publish({ ...context, sourceIds: [documentId, body.secondaryDocumentId] }, artifact);
}
