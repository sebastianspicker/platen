import { HostError } from '../host-error.mjs';
import {
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  PROJECT_BUNDLE_MAX_BYTES,
  PROJECT_BUNDLE_MEDIA_TYPE,
} from '../project-bundle-service.mjs';
import { bindSourceBoundAecDomainRequest } from './source-bound-aec-domain.mjs';
import { bindSourceBoundCollaborationDomainRequest } from './source-bound-collaboration-domain.mjs';

const WORKSPACE_JSON_BODY_LIMIT = 768 * 1024;
const AEC_JSON_BODY_LIMIT = 8_192;

export async function handleDomainCatalogRoute(context) {
  const { pathname, request, response, domainFacade, method, json } = context;
  if (pathname !== '/api/domains') return false;
  if (!domainFacade) throw new HostError('DOMAIN_API_UNAVAILABLE', 'Local workflow domains are unavailable.', 503);
  method(request, 'GET');
  json(response, 200, { operations: domainFacade.listOperations() });
  return true;
}

export async function handleWorkspaceRoute(context) {
  const {
    request, response, url, documentId, operation, processing, store, workspaceState,
    domainFacade, aecArtifacts, projectBundles, method, json, empty, write, readJson,
    readBytes, parsePositiveInteger, requireContentType, sendPortableProject,
  } = context;
  if (!operation) {
    if (request.method === 'GET') {
      json(response, 200, { document: store.getDocument(documentId) });
      return true;
    }
    if (request.method === 'DELETE') {
      workspaceState.deleteDocument(documentId);
      await store.deleteDocument(documentId);
      empty(response);
      return true;
    }
    throw new HostError('METHOD_NOT_ALLOWED', 'This endpoint supports GET and DELETE.', 405);
  }
  if (operation === 'workspace') {
    if (request.method === 'GET') {
      json(response, 200, { workspace: workspaceState.snapshot(documentId) });
      return true;
    }
    if (request.method === 'PUT') {
      const body = await readJson(request, WORKSPACE_JSON_BODY_LIMIT);
      json(response, 200, { workspace: workspaceState.replaceSnapshot(documentId, body.snapshot, { expectedRevision: body.expectedRevision }) });
      return true;
    }
    if (request.method === 'POST') {
      const body = await readJson(request, WORKSPACE_JSON_BODY_LIMIT);
      const options = { expectedRevision: body.expectedRevision };
      let workspace;
      if (body.action === 'create') workspace = workspaceState.createEntity(documentId, body.namespace, body.entity, options);
      else if (body.action === 'update') workspace = workspaceState.updateEntity(documentId, body.namespace, body.entityId, body.entity, options);
      else if (body.action === 'delete') workspace = workspaceState.deleteEntity(documentId, body.namespace, body.entityId, options);
      else if (body.action === 'event') workspace = workspaceState.appendAuditEvent(documentId, body.event, options);
      else throw new HostError('INVALID_WORKSPACE_ACTION', 'Unsupported workspace mutation action.', 400);
      json(response, 200, { workspace });
      return true;
    }
    throw new HostError('METHOD_NOT_ALLOWED', 'Workspace state supports GET, POST, and PUT.', 405);
  }
  if (operation === 'domain') {
    if (!domainFacade) throw new HostError('DOMAIN_API_UNAVAILABLE', 'Local workflow domains are unavailable.', 503);
    method(request, 'POST');
    const body = await readJson(request, WORKSPACE_JSON_BODY_LIMIT);
    const aecBound = bindSourceBoundAecDomainRequest(documentId, body, workspaceState, store);
    const bound = bindSourceBoundCollaborationDomainRequest(documentId, aecBound, workspaceState, store);
    json(response, 200, { result: await domainFacade.execute(documentId, bound) });
    return true;
  }
  const aecMethod = { 'aec-calibration': 'calibrate', 'aec-measurement': 'measure', 'aec-materialization': 'materialize' }[operation];
  if (aecMethod) {
    if (!aecArtifacts) throw new HostError('AEC_ARTIFACTS_UNAVAILABLE', 'Source-bound local AEC geometry is unavailable.', 503);
    method(request, 'POST');
    json(response, 201, { result: await aecArtifacts[aecMethod](documentId, await readJson(request, AEC_JSON_BODY_LIMIT), processing) });
    return true;
  }
  if (operation === 'project-bundle') {
    if (!projectBundles) throw new HostError('PROJECT_BUNDLE_UNAVAILABLE', 'Local project bundles are unavailable.', 503);
    if (request.method === 'GET') {
      if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Project bundle export does not accept query parameters.', 400);
      write(response, 200, projectBundles.exportBundle(documentId), `${PROJECT_BUNDLE_MEDIA_TYPE}; charset=utf-8`);
      return true;
    }
    if (request.method === 'POST') {
      requireContentType(request, PROJECT_BUNDLE_MEDIA_TYPE);
      if (url.searchParams.getAll('expectedRevision').length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'expectedRevision')) {
        throw new HostError('INVALID_PARAMETER', 'Project bundle import requires exactly one expectedRevision parameter.', 400);
      }
      const expectedRevision = parsePositiveInteger(url.searchParams.get('expectedRevision'), 'expectedRevision', { minimum: 0 });
      json(response, 200, { workspace: projectBundles.importBundle(documentId, await readBytes(request, PROJECT_BUNDLE_MAX_BYTES), { expectedRevision }) });
      return true;
    }
    throw new HostError('METHOD_NOT_ALLOWED', 'Project bundles support GET and POST.', 405);
  }
  if (operation !== 'portable-project-bundle') return false;
  if (!projectBundles || typeof projectBundles.exportPortableBundle !== 'function') {
    throw new HostError('PORTABLE_PROJECT_UNAVAILABLE', 'Portable local project bundles are unavailable.', 503);
  }
  method(request, 'GET');
  if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Portable project export does not accept query parameters.', 400);
  sendPortableProject(response, await projectBundles.exportPortableBundle(documentId));
  return true;
}

export async function handlePortableProjectImportRoute(context) {
  const { pathname, request, response, processing, projectBundles, method, requireContentType, json } = context;
  if (pathname !== '/api/project-bundles') return false;
  if (!projectBundles || typeof projectBundles.importPortableBundle !== 'function') {
    throw new HostError('PORTABLE_PROJECT_UNAVAILABLE', 'Portable local project bundles are unavailable.', 503);
  }
  method(request, 'POST');
  if ([...context.url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Portable project import does not accept query parameters.', 400);
  requireContentType(request, PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE);
  json(response, 201, { result: await projectBundles.importPortableBundle(request, processing) });
  return true;
}
