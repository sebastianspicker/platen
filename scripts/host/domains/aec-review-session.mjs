import {
  digest, fail, id, list, plain,
} from './aec-collaboration-support.mjs';

const INPUT_KEYS = Object.freeze(['id', 'workspaceId', 'participants', 'sourceSha256']);
const OPTION_KEYS = Object.freeze(['expectedRevision']);

function exactPlain(value, keys, label) {
  if (!plain(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_INPUT', `${label} must be a plain object.`);
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail('INVALID_INPUT', `${label} contains unsupported fields.`);
  }
  return value;
}

function sourceBoundParticipants(value) {
  const participants = list(value, 'participants', 50);
  if (participants.length < 1) {
    fail('INVALID_REVIEW_SESSION', 'Source-bound review sessions require at least one participant.');
  }
  const seen = new Set();
  return participants.map((participant, index) => {
    let normalized;
    try {
      normalized = id(participant, `participants[${index}]`);
    } catch {
      fail('INVALID_REVIEW_SESSION', 'Source-bound review session participant identifiers are invalid.');
    }
    if (seen.has(normalized)) {
      fail('INVALID_REVIEW_SESSION', 'Source-bound review sessions must not contain duplicate participants.');
    }
    seen.add(normalized);
    return normalized;
  });
}

function assertBoundRevision(snapshot, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || expectedRevision !== snapshot.revision) {
    fail(
      'REVISION_CONFLICT',
      'Source-bound review-session creation requires the current workspace revision.',
      409,
    );
  }
}

/** Create a local AEC review-session descriptor, optionally bound to current source bytes. */
export function createReviewSession(domain, documentId, input, options = {}) {
  const normalizedInput = exactPlain(input, INPUT_KEYS, 'createReviewSession input');
  const normalizedOptions = exactPlain(options, OPTION_KEYS, 'createReviewSession options');
  const {
    id: suppliedId, workspaceId, participants, sourceSha256,
  } = normalizedInput;

  if (sourceSha256 === undefined) {
    const record = {
      id: domain.newId('review', suppliedId),
      type: 'review-session',
      workspaceId: id(workspaceId, 'workspaceId'),
      participants: list(participants === undefined ? [] : participants, 'participants', 100)
        .map((participant) => id(participant, 'participant')),
      createdAt: domain.now(),
    };
    return domain.write(documentId, 'reviewRecords', record, normalizedOptions.expectedRevision);
  }

  const snapshot = domain.snapshot(documentId);
  assertBoundRevision(snapshot, normalizedOptions.expectedRevision);
  const source = digest(sourceSha256, 'sourceSha256');
  const normalizedParticipants = sourceBoundParticipants(participants);
  const record = {
    id: domain.newId('review', suppliedId),
    type: 'review-session',
    workspaceId: id(workspaceId, 'workspaceId'),
    participants: normalizedParticipants,
    sourceSha256: source,
    basisRevision: snapshot.revision,
    createdAt: domain.now(),
  };
  return domain.write(documentId, 'reviewRecords', record, normalizedOptions.expectedRevision);
}
