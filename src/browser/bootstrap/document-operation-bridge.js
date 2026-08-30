export function createDocumentOperationBridge() {
  let documentOperations = null;

  function setDocumentOperations(value) {
    documentOperations = value;
  }

  function getDocumentOperations() {
    return documentOperations;
  }

  function captureDocumentOperation() {
    return documentOperations.capture();
  }

  function operationIsCurrent(operation) {
    return documentOperations.isCurrent(operation);
  }

  function reportOperationError(error, operation) {
    documentOperations.reportError(error, operation);
  }

  function finishDocumentOperation(operation) {
    documentOperations.finish(operation);
  }

  async function downloadDerivedArtifact(artifact, operation, message) {
    return documentOperations.downloadDerivedArtifact(artifact, operation, message);
  }

  async function downloadEphemeralDerivedArtifact(artifact, operation, message) {
    return documentOperations.downloadEphemeralDerivedArtifact(artifact, operation, message);
  }

  return Object.freeze({
    setDocumentOperations,
    getDocumentOperations,
    captureDocumentOperation,
    operationIsCurrent,
    reportOperationError,
    finishDocumentOperation,
    downloadDerivedArtifact,
    downloadEphemeralDerivedArtifact,
  });
}
