import { HostError } from '../host-error.mjs';

export async function handleArtifactRoute(context) {
  const { pathname, request, response, store, method, empty, sendArtifact } = context;
  const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
  if (!artifactMatch) return false;
  if ([...context.url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Artifact requests do not accept query parameters.', 400);
  if (request.method === 'DELETE') {
    await store.deleteArtifact(artifactMatch[1]);
    empty(response);
    return true;
  }
  method(request, 'GET');
  const artifact = store.getArtifact(artifactMatch[1]);
  if (artifact.operation?.type !== 'pdfkit-protection-removal') {
    sendArtifact(response, artifact);
    return true;
  }
  const claim = store.claimArtifactForTransfer(artifact.id);
  try {
    sendArtifact(response, claim.artifact, { onSettled: claim.cleanup });
  } catch (error) {
    await claim.cleanup().catch(() => {});
    throw error;
  }
  return true;
}
