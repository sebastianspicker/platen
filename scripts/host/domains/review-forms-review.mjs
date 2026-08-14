import {
  ANNOTATION_TYPES,
  MAX_PAGE,
  MAX_RECORDS,
  MAX_RECT,
  MAX_TEXT,
  STATUSES,
  date,
  fail,
  find,
  id,
  integer,
  rect,
  string,
} from './review-forms-validation.mjs';
import { exportReviewJson, importReviewJson, reviewSummary } from './review-forms-review-interchange.mjs';
import { queryAnnotations } from './review-forms-review-query.mjs';

export class ReviewFormsReviewDomain {
  #workspace;

  constructor(workspace) { this.#workspace = workspace; }

  #activity(snapshot, annotationId, kind, actor, detail = '') {
    if (snapshot.namespaces.reviewRecords.length >= MAX_RECORDS) {
      fail('REVIEW_LIMIT_EXCEEDED', 'The review workspace record limit has been reached.', 413);
    }
    snapshot.namespaces.reviewRecords.push({
      id: this.#workspace.newId('activity'), kind: 'activity', annotationId,
      activity: string(kind, 'activity', { required: true, max: 64 }),
      actor: string(actor, 'actor', { max: 128 }), detail: string(detail, 'detail', { max: 500 }),
      at: this.#workspace.now(),
    });
  }

  #properties(value) {
    if (value == null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 24) {
      fail('INVALID_PROPERTIES', 'properties must be a bounded object.');
    }
    const properties = {};
    for (const [key, item] of Object.entries(value)) {
      id(key, 'property key');
      properties[key] = string(item, 'property value', { max: 500 });
    }
    return properties;
  }

  #mentions(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 32) fail('INVALID_MENTIONS', 'mentions must be a bounded array.');
    return value.map((item) => string(item, 'mention', { required: true, max: 128 }));
  }

  #reference(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('INVALID_REFERENCE', 'reference metadata is required.');
    }
    const kind = string(value.kind, 'reference kind', { required: true, max: 16 });
    if (!['file', 'audio'].includes(kind)) fail('INVALID_REFERENCE', 'reference kind must be file or audio.');
    return { kind, label: string(value.label, 'reference label', { required: true, max: 256 }), mimeType: string(value.mimeType, 'mime type', { max: 128 }) ?? '' };
  }

  #measurement(value) {
    if (!value || typeof value !== 'object' || !Number.isFinite(value.value) || Math.abs(value.value) > MAX_RECT) {
      fail('INVALID_MEASUREMENT', 'measurement value is required.');
    }
    return { value: value.value, unit: string(value.unit, 'measurement unit', { required: true, max: 32 }) };
  }

  createAnnotation(documentId, input, { expectedRevision } = {}) {
    const type = string(input?.type, 'annotation type', { required: true, max: 32 });
    if (!ANNOTATION_TYPES.has(type)) fail('INVALID_ANNOTATION_TYPE', 'Unsupported annotation type.');
    const annotationId = input?.id == null ? this.#workspace.newId('annotation') : id(input.id, 'annotation id');
    return this.#workspace.mutate(documentId, expectedRevision, (snapshot) => {
      if (snapshot.namespaces.annotations.length >= MAX_RECORDS) fail('ANNOTATION_LIMIT_EXCEEDED', 'The annotation limit has been reached.', 413);
      if (snapshot.namespaces.annotations.some((annotation) => annotation.id === annotationId)) fail('ENTITY_EXISTS', 'An annotation with this identifier already exists.', 409);
      const status = input.status ?? 'open';
      if (!STATUSES.has(status)) fail('INVALID_STATUS', 'Unsupported annotation status.');
      const annotation = {
        id: annotationId, prototypeSidecar: true, type, page: integer(input.page, 'page', 1, MAX_PAGE),
        rectangle: rect(input.rectangle), text: string(input.text, 'text', { max: MAX_TEXT }) ?? '', author: string(input.author, 'author', { max: 128 }) ?? '', status,
        customStatus: status === 'custom' ? string(input.customStatus, 'customStatus', { required: true, max: 80 }) : undefined,
        properties: this.#properties(input.properties), mentions: this.#mentions(input.mentions), createdAt: this.#workspace.now(), replies: [],
      };
      if (type === 'reference') annotation.reference = this.#reference(input.reference);
      if (type === 'measurement') annotation.measurement = this.#measurement(input.measurement);
      if (type === 'stamp') annotation.stamp = string(input.stamp, 'stamp', { required: true, max: 128 });
      snapshot.namespaces.annotations.push(annotation);
      this.#activity(snapshot, annotationId, 'created', annotation.author, type);
    });
  }

  reply(documentId, annotationId, input, { expectedRevision } = {}) {
    return this.#workspace.mutate(documentId, expectedRevision, (snapshot) => {
      const annotation = find(snapshot, 'annotations', id(annotationId, 'annotation id'), 'annotation');
      if (annotation.replies.length >= 64) fail('REPLY_LIMIT_EXCEEDED', 'The reply limit has been reached.', 413);
      const reply = { id: input?.id == null ? this.#workspace.newId('reply') : id(input.id, 'reply id'), text: string(input?.text, 'reply text', { required: true }), author: string(input?.author, 'author', { required: true, max: 128 }), at: this.#workspace.now() };
      if (annotation.replies.some((record) => record.id === reply.id)) fail('ENTITY_EXISTS', 'A reply with this identifier already exists.', 409);
      annotation.replies.push(reply);
      this.#activity(snapshot, annotation.id, 'reply', reply.author, reply.text);
    });
  }

  updateAnnotation(documentId, annotationId, patch, { expectedRevision } = {}) {
    return this.#workspace.mutate(documentId, expectedRevision, (snapshot) => {
      const annotation = find(snapshot, 'annotations', id(annotationId, 'annotation id'), 'annotation');
      if (patch?.text !== undefined) annotation.text = string(patch.text, 'text', { max: MAX_TEXT });
      if (patch?.properties !== undefined) annotation.properties = this.#properties(patch.properties);
      if (patch?.status !== undefined) {
        if (!STATUSES.has(patch.status)) fail('INVALID_STATUS', 'Unsupported annotation status.');
        annotation.status = patch.status;
        annotation.customStatus = patch.status === 'custom' ? string(patch.customStatus, 'customStatus', { required: true, max: 80 }) : undefined;
      }
      if (patch?.mentions !== undefined) annotation.mentions = this.#mentions(patch.mentions);
      this.#activity(snapshot, annotation.id, 'updated', annotation.author, annotation.status);
    });
  }

  setReviewState(documentId, input, { expectedRevision } = {}) {
    return this.#workspace.mutate(documentId, expectedRevision, (snapshot) => {
      const state = { id: 'review-state', kind: 'reviewState', participants: this.#mentions(input?.participants), dueDate: input?.dueDate == null ? '' : date(input.dueDate, 'dueDate'), tracking: string(input?.tracking ?? '', 'tracking', { max: 500 }) };
      const records = snapshot.namespaces.reviewRecords;
      const index = records.findIndex((record) => record.id === state.id);
      if (index < 0) records.push(state);
      else records[index] = state;
    });
  }

  queryAnnotations(documentId, query = {}) { return queryAnnotations(this.#workspace.snapshot(documentId), query); }
  exportReviewJson(documentId) { return exportReviewJson(this.#workspace.snapshot(documentId)); }
  importReviewJson(documentId, interchange, { expectedRevision } = {}) { return importReviewJson(this.#workspace, documentId, interchange, expectedRevision); }
  reviewSummary(documentId) { return reviewSummary(this.#workspace.snapshot(documentId)); }
}
