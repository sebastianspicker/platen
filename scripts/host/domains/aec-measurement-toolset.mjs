import { digest, fail } from './aec-collaboration-support.mjs';

const MEASUREMENT_TOOLS = Object.freeze([
  Object.freeze({ id: 'distance', kind: 'distance', dimension: 'length', siUnit: 'm' }),
  Object.freeze({ id: 'perimeter', kind: 'perimeter', dimension: 'length', siUnit: 'm' }),
  Object.freeze({ id: 'area', kind: 'area', dimension: 'area', siUnit: 'm2' }),
  Object.freeze({ id: 'count', kind: 'count', dimension: 'count', siUnit: 'count' }),
]);

function exactPlain(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_INPUT', `${label} must be a plain object.`);
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail('INVALID_INPUT', `${label} contains unsupported fields.`);
  }
  return value;
}

function assertBoundRevision(snapshot, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || expectedRevision !== snapshot.revision) {
    fail(
      'REVISION_CONFLICT',
      'Source-bound measurement toolset lookup requires the current workspace revision.',
      409,
    );
  }
}

/** Return the fixed source-bound local measurement catalog without persisting state. */
export function measurementToolset(domain, documentId, input = {}, options = {}) {
  const request = exactPlain(input, ['sourceSha256'], 'measurementToolset input');
  const requestOptions = exactPlain(options, ['expectedRevision'], 'measurementToolset options');
  const snapshot = domain.snapshot(documentId);
  assertBoundRevision(snapshot, requestOptions.expectedRevision);
  const sourceSha256 = digest(request.sourceSha256, 'sourceSha256');

  return Object.freeze({
    kind: 'source-bound-aec-measurement-toolset',
    schemaVersion: 1,
    sourceSha256,
    workspaceRevision: snapshot.revision,
    tools: MEASUREMENT_TOOLS,
  });
}
