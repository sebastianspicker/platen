export async function scheduleArtifactCleanup({ processing, response, store }, artifactId) {
  if (processing.signal.aborted || response.destroyed) {
    await store.deleteArtifact(artifactId);
    return true;
  }
  let responseDelivered = false;
  response.once('finish', () => { responseDelivered = true; });
  response.once('close', () => {
    if (!responseDelivered) void store.deleteArtifact(artifactId).catch(() => {});
  });
  return false;
}

export async function scheduleDocumentCleanup({ processing, response, store }, documentId) {
  if (processing.signal.aborted || response.destroyed) {
    await store.deleteDocument(documentId);
    return true;
  }
  let responseDelivered = false;
  response.once('finish', () => { responseDelivered = true; });
  response.once('close', () => {
    if (!responseDelivered) void store.deleteDocument(documentId).catch(() => {});
  });
  return false;
}
