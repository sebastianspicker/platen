/**
 * Local multi-session review synchronization store.
 * Sessions share one process-local bus; sync is real (shared state + events), not network RT.
 */
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HostError } from '../host-error.mjs';

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export class LocalReviewSyncHub extends EventEmitter {
  #rooms = new Map();

  createSession({ documentKey = 'doc-1', participants = ['a', 'b'] } = {}) {
    const id = randomUUID();
    const room = {
      id,
      documentKey: String(documentKey),
      participants: [...new Set(participants.map(String))].slice(0, 50),
      annotations: [],
      revision: 0,
      createdAt: new Date().toISOString(),
    };
    this.#rooms.set(id, room);
    this.emit('session-created', { sessionId: id, documentKey: room.documentKey });
    return this.snapshot(id);
  }

  snapshot(sessionId) {
    const room = this.#require(sessionId);
    return Object.freeze({
      id: room.id,
      documentKey: room.documentKey,
      participants: Object.freeze([...room.participants]),
      annotationCount: room.annotations.length,
      revision: room.revision,
      createdAt: room.createdAt,
      stateSha256: digest({
        id: room.id, revision: room.revision, annotations: room.annotations, participants: room.participants,
      }),
    });
  }

  join(sessionId, participantId) {
    const room = this.#require(sessionId);
    const participant = String(participantId ?? '');
    if (!participant) fail('INVALID_PARTICIPANT', 'participantId required.');
    if (!room.participants.includes(participant)) {
      if (room.participants.length >= 50) fail('SESSION_FULL', 'Session participant limit reached.', 409);
      room.participants.push(participant);
      room.revision += 1;
      this.emit('participant-joined', { sessionId, participant, revision: room.revision });
    }
    return this.snapshot(sessionId);
  }

  postAnnotation(sessionId, participantId, annotation) {
    const room = this.#require(sessionId);
    if (!room.participants.includes(String(participantId))) fail('NOT_A_PARTICIPANT', 'Join the session before posting.', 403);
    const record = Object.freeze({
      id: randomUUID(),
      participantId: String(participantId),
      page: Number.isSafeInteger(annotation?.page) ? annotation.page : 1,
      type: String(annotation?.type ?? 'Text'),
      body: String(annotation?.body ?? '').slice(0, 2000),
      at: new Date().toISOString(),
    });
    if (!record.body) fail('INVALID_ANNOTATION', 'Annotation body required.');
    room.annotations.push(record);
    room.revision += 1;
    this.emit('annotation-posted', { sessionId, annotation: record, revision: room.revision });
    return Object.freeze({ annotation: record, session: this.snapshot(sessionId) });
  }

  listAnnotations(sessionId) {
    const room = this.#require(sessionId);
    return Object.freeze({ sessionId, revision: room.revision, annotations: Object.freeze([...room.annotations]) });
  }

  /**
   * Real-time local sync: second session attachment receives current revision and can observe posts.
   */
  attachObserver(sessionId) {
    const room = this.#require(sessionId);
    const events = [];
    const onPost = (event) => {
      if (event.sessionId === sessionId) events.push(event);
    };
    this.on('annotation-posted', onPost);
    return Object.freeze({
      sessionId,
      revision: room.revision,
      pull() { return Object.freeze([...events]); },
      detach: () => this.off('annotation-posted', onPost),
    });
  }

  #require(sessionId) {
    const room = this.#rooms.get(sessionId);
    if (!room) fail('SESSION_NOT_FOUND', 'Review session not found.', 404);
    return room;
  }
}

let sharedHub = null;
export function getSharedReviewHub() {
  sharedHub ??= new LocalReviewSyncHub();
  return sharedHub;
}

export function resetSharedReviewHubForTests() {
  sharedHub = new LocalReviewSyncHub();
  return sharedHub;
}
