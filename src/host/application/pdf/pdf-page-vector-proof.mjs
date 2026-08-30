import { createHash } from 'node:crypto';
import { INCREMENTAL_PAGE_VECTOR_PROFILE } from './pdf-page-vector-contract.mjs';

export function changedId(sourceBytes, request) {
  return createHash('sha256').update('Platen incremental page-vector ID v1\0', 'utf8')
    .update(createHash('sha256').update(sourceBytes).digest())
    .update(JSON.stringify(request), 'utf8')
    .digest().subarray(0, 16);
}

export function vectorStream(request) {
  const { x, y, width, height } = request.rect;
  return Buffer.from(`q 0 0 0 RG 1 w ${x} ${y} ${width} ${height} re S Q\n`, 'latin1');
}

export function pageVectorProof(sourceBytes, output, append, request, state, idPolicy) {
  return Object.freeze({
    profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
    sourceBytes: sourceBytes.length,
    outputBytes: output.buffer.length,
    appendedBytes: append.bytes.length,
    sourcePrefixPreserved: true,
    revisionCount: output.revisions.length,
    previousXrefOffset: output.revisions[1].offset,
    appendedXrefOffset: append.revision.xrefOffset,
    page: request.page,
    rect: request.rect,
    sourcePageObjectNumber: state.page.reference.object,
    sourcePageGeneration: state.page.reference.generation,
    sourcePageReference: state.pageObjectText,
    vectorStreamObjectNumber: append.streamReference.object,
    vectorStreamGeneration: append.streamReference.generation,
    effectiveSize: output.finalSize,
    rootPreserved: true,
    infoPreserved: true,
    idPolicy,
  });
}
