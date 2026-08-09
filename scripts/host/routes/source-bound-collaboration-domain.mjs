import { HostError } from '../host-error.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const BOUND_OPERATIONS = new Set(['createRevision', 'transitionRevision']);

function invalid(label) {
  throw new HostError('INVALID_PARAMETER', `Invalid collaboration ${label}.`, 400);
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid(label);
  return structuredClone(value);
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(label);
  return value;
}

function boundedText(value, label, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid(label);
  return value.trim();
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(label);
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string') invalid(label);
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized)) invalid(label);
  return normalized;
}

function assertBinding(providedSource, providedRevision, trustedSource, currentRevision) {
  if (providedSource !== trustedSource) {
    throw new HostError('SOURCE_VERSION_MISMATCH', 'Collaboration request source digest does not match the current document.', 409);
  }
  if (providedRevision !== currentRevision) {
    throw new HostError('REVISION_CONFLICT', 'Collaboration request revision does not match the current workspace.', 409);
  }
}

export function bindSourceBoundCollaborationDomainRequest(documentId, request, workspaceState, store) {
  if (!request || request.group !== 'collaboration' || !BOUND_OPERATIONS.has(request.operation)) return request;

  const body = plain(request.body, 'domain body');
  const create = request.operation === 'createRevision';
  const input = create ? plain(body.input, 'revision input') : null;
  const suppliedSource = create ? input.sourceSha256 : body.sourceSha256;
  if (suppliedSource === undefined) return request;

  if (create) {
    exactKeys(body, ['input', 'options'], 'createRevision body');
    exactKeys(input, ['id', 'label', 'sourceSha256'], 'createRevision input');
    boundedText(input.label, 'revision label');
  } else {
    exactKeys(body, ['revisionId', 'nextStatus', 'sourceSha256', 'options'], 'transitionRevision body');
    boundedText(body.revisionId, 'revision id', 128);
    if (!['draft', 'issued', 'superseded'].includes(body.nextStatus)) invalid('revision status');
  }

  const document = store.getDocument(documentId);
  const trustedSource = sha256(document.sha256, 'trusted source digest');
  const currentRevision = workspaceState.snapshot(documentId).revision;
  const options = exactKeys(plain(body.options, `${request.operation} options`), ['expectedRevision'], `${request.operation} options`);
  const providedSource = sha256(suppliedSource, `${request.operation} source digest`);
  const providedRevision = revision(options.expectedRevision, `${request.operation} expected revision`);
  assertBinding(providedSource, providedRevision, trustedSource, currentRevision);

  if (!create) {
    return {
      ...request,
      body: {
        ...body,
        sourceSha256: trustedSource,
        options: { expectedRevision: currentRevision, sourceSha256: trustedSource },
      },
    };
  }

  return {
    ...request,
    body: {
      ...body,
      input: { ...input, sourceSha256: trustedSource },
      options: { expectedRevision: currentRevision },
    },
  };
}
