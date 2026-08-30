import { date, fail, id, json } from './review-forms-validation.mjs';

export class ReviewFormsWorkspace {
  #store;
  #clock;
  #id;

  constructor(
    workspaceStateStore,
    {
      clock = () => '1970-01-01T00:00:00.000Z',
      idFactory = (() => { let number = 0; return (prefix) => `${prefix}-${++number}`; })(),
    } = {},
  ) {
    if (!workspaceStateStore || typeof workspaceStateStore.snapshot !== 'function'
      || typeof workspaceStateStore.replaceSnapshot !== 'function') {
      throw new TypeError('ReviewFormsDomain requires WorkspaceStateStore.');
    }
    this.#store = workspaceStateStore;
    this.#clock = clock;
    this.#id = idFactory;
  }

  snapshot(documentId) { return this.#store.snapshot(documentId); }

  mutate(documentId, expectedRevision, change) {
    const snapshot = json(this.#store.snapshot(documentId));
    if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) {
      fail(
        'REVISION_CONFLICT',
        'The workspace state revision does not match the expected revision.',
        409,
      );
    }
    change(snapshot);
    // JSON normalization removes optional undefined keys before the store's strict JSON check.
    return this.#store.replaceSnapshot(
      documentId,
      json(snapshot),
      { expectedRevision: snapshot.revision },
    );
  }

  newId(prefix) { return id(this.#id(prefix), 'generated id'); }

  now() { return date(this.#clock(), 'clock result'); }
}
