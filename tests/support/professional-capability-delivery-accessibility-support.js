import { createHash } from 'node:crypto';

export function productionArtifact({ id, documentId, sourceSha256, bytes, operationType }) {
  const outputSha256 = createHash('sha256').update(bytes).digest('hex');
  const operation = Object.freeze({ type: operationType, inputs: Object.freeze([{ documentId, sha256: sourceSha256, role: 'source' }]), validation: Object.freeze({ passed: true, outputSha256 }) });
  return Object.freeze({ id, documentId, mediaType: 'application/pdf', size: bytes.length, sha256: outputSha256, operation });
}
export function productionReceipt(kind, artifact, proof) {
  return Object.freeze({ kind, artifact, proof, limitations: Object.freeze(['Bounded test subset.']) });
}
