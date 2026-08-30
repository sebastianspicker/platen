import { digest, fail, id } from './aec-collaboration-support.mjs';

function assertBoundRevision(snapshot, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || expectedRevision !== snapshot.revision) {
    fail(
      'REVISION_CONFLICT',
      'Source-bound revision overlay creation requires the current workspace revision.',
      409,
    );
  }
}

export function createRevisionOverlay(domain, documentId, {
  id: suppliedId, fromDigest, toDigest, sheetId, sourceSha256,
}, options = {}) {
  if (sourceSha256 === undefined) {
    const record = {
      id: domain.newId('overlay', suppliedId),
      type: 'revision-overlay',
      fromDigest: digest(fromDigest, 'fromDigest'),
      toDigest: digest(toDigest, 'toDigest'),
      sheetId: id(sheetId, 'sheetId'),
      createdAt: domain.now(),
    };
    if (record.fromDigest === record.toDigest) {
      fail('INVALID_REVISION_OVERLAY', 'Revision overlays must link two distinct digests.');
    }
    return domain.write(documentId, 'reviewRecords', record, options.expectedRevision);
  }

  const snapshot = domain.snapshot(documentId);
  assertBoundRevision(snapshot, options.expectedRevision);

  const source = digest(sourceSha256, 'sourceSha256');
  const from = digest(fromDigest, 'fromDigest');
  const to = digest(toDigest, 'toDigest');
  if (to !== source) {
    fail(
      'SOURCE_VERSION_MISMATCH',
      'Revision overlay target digest does not match the source binding.',
      409,
    );
  }
  if (from === to) {
    fail('INVALID_REVISION_OVERLAY', 'Revision overlays must link two distinct digests.');
  }

  const record = {
    id: domain.newId('overlay', suppliedId),
    type: 'revision-overlay',
    fromDigest: from,
    toDigest: to,
    sheetId: id(sheetId, 'sheetId'),
    sourceSha256: source,
    basisRevision: snapshot.revision,
    mode: 'descriptor-only',
    createdAt: domain.now(),
  };
  return domain.write(documentId, 'reviewRecords', record, options.expectedRevision);
}
