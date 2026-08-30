function boundMethod(target, method, owner) {
  if (!target || typeof target[method] !== 'function') {
    throw new TypeError(`CLI application facade requires ${owner}.${method}().`);
  }
  return target[method].bind(target);
}

export function createCliApplicationFacade({ store, inputs, automation, close, validateOperationProvenance } = {}) {
  const documents = Object.freeze({
    create: boundMethod(store, 'createDocument', 'store'),
    get: boundMethod(store, 'getDocument', 'store'),
    verify: boundMethod(store, 'verifySource', 'store'),
    delete: boundMethod(store, 'deleteDocument', 'store'),
  });
  const artifacts = Object.freeze({
    get: boundMethod(store, 'getArtifact', 'store'),
    delete: boundMethod(store, 'deleteArtifact', 'store'),
  });
  const inputAssets = Object.freeze({
    create: boundMethod(inputs, 'createInput', 'inputs'),
    get: boundMethod(inputs, 'getInput', 'inputs'),
    verify: boundMethod(inputs, 'verifyInput', 'inputs'),
    delete: boundMethod(inputs, 'deleteInput', 'inputs'),
  });
  const stageSource = ({ documentId, signal } = {}) => {
    if (!automation?.sources || typeof automation.sources.stageDocument !== 'function') {
      throw new TypeError('CLI automation source staging is unavailable.');
    }
    return automation.sources.stageDocument({ store, documentId, signal });
  };
  return Object.freeze({
    documents,
    artifacts,
    inputs: inputAssets,
    validateOperationProvenance: boundMethod({ validateOperationProvenance }, 'validateOperationProvenance', 'operation provenance validator'),
    automation: Object.freeze({ stageSource }),
    close: boundMethod({ close }, 'close', 'application'),
  });
}
