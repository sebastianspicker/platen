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
