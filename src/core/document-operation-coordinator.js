/**
 * Coordinates document-bound asynchronous operations without owning UI state.
 * Callers supply their current document identity and the narrow UI callbacks.
 */
export class DocumentOperationCoordinator {
  #getGeneration;
  #getDocumentId;
  #client;
  #onCapture;
  #onFinish;
  #onCancelled;
  #onError;
  #onCancel;
  #onDownload;

  activeController = null;

  constructor({
    getGeneration,
    getDocumentId,
    client,
    onCapture = () => {},
    onFinish = () => {},
    onCancelled = () => {},
    onError = () => {},
    onCancel = () => {},
    onDownload,
  }) {
    this.#getGeneration = getGeneration;
    this.#getDocumentId = getDocumentId;
    this.#client = client;
    this.#onCapture = onCapture;
    this.#onFinish = onFinish;
    this.#onCancelled = onCancelled;
    this.#onError = onError;
    this.#onCancel = onCancel;
    this.#onDownload = onDownload;
  }

  capture() {
    const controller = new AbortController();
    this.activeController = controller;
    this.#onCapture();
    return Object.freeze({
      generation: this.#getGeneration(),
      documentId: this.#getDocumentId(),
      controller,
    });
  }

  isCurrent(operation) {
    return operation.generation === this.#getGeneration()
      && operation.documentId === this.#getDocumentId();
  }

  reportError(error, operation) {
    if (!this.isCurrent(operation)) return;
    if (operation.controller.signal.aborted) {
      this.#onCancelled();
      return;
    }
    this.#onError(error);
  }

  finish(operation) {
    if (!this.isCurrent(operation) || this.activeController !== operation.controller) return;
    this.activeController = null;
    this.#onFinish();
  }

  cancel(reason = new Error('Cancelled by the user.')) {
    if (!this.activeController || this.activeController.signal.aborted) return false;
    this.activeController.abort(reason);
    this.#onCancel();
    return true;
  }

  async downloadDerivedArtifact(artifact, operation, message) {
    const blob = await this.#client.artifact(artifact.id, { signal: operation.controller.signal });
    if (!this.isCurrent(operation)) return false;
    this.#onDownload({ blob, fileName: artifact.displayName, message });
    return true;
  }

  async downloadEphemeralDerivedArtifact(artifact, operation, message) {
    let blob = null;
    let retrievalError = null;
    try {
      blob = await this.#client.artifact(artifact.id, { signal: operation.controller.signal });
    } catch (error) {
      retrievalError = error;
    }
    let cleanupError = null;
    try {
      await this.#client.deleteArtifact(artifact.id, { keepalive: true });
    } catch (error) {
      if (error?.code !== 'ARTIFACT_NOT_FOUND') cleanupError = error;
    }
    if (retrievalError) throw retrievalError;
    if (cleanupError) throw cleanupError;
    if (!this.isCurrent(operation)) return false;
    this.#onDownload({ blob, fileName: artifact.displayName, message });
    return true;
  }
}
