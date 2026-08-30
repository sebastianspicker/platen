import {
  digest, fail, id, list, plain,
} from './aec-collaboration-support.mjs';

function invalidPlan(message) {
  fail('INVALID_PLAN', message);
}

function sourceBoundPairs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    invalidPlan('Source-bound batch plans require between 1 and 100 pairs.');
  }

  const fromIds = new Set();
  const toIds = new Set();
  return value.map((pair, index) => {
    if (!plain(pair) || Object.getPrototypeOf(pair) !== Object.prototype
      || Object.keys(pair).length !== 2
      || !Object.hasOwn(pair, 'from') || !Object.hasOwn(pair, 'to')) {
      invalidPlan(`Source-bound pair ${index} must contain exactly from and to.`);
    }

    let from;
    let to;
    try {
      from = id(pair.from, `pair[${index}].from`);
      to = id(pair.to, `pair[${index}].to`);
    } catch {
      invalidPlan(`Source-bound pair ${index} identifiers are invalid.`);
    }

    if (from === to) invalidPlan('Source-bound batch pairs must reference distinct identifiers.');
    if (fromIds.has(from) || toIds.has(to)) {
      invalidPlan('Source-bound batch pairs must not duplicate from or to identifiers.');
    }
    fromIds.add(from);
    toIds.add(to);
    return { from, to };
  });
}

/** Create a local AEC batch plan, optionally bound to the current source revision. */
export function createBatchPlan(
  domain,
  documentId,
  { id: suppliedId, kind, pairs, sourceSha256 },
  options = {},
) {
  if (sourceSha256 === undefined) {
    if (!['slip-sheet', 'link'].includes(kind)) fail('INVALID_PLAN', 'Plan kind must be slip-sheet or link.');
    const record = {
      id: domain.newId('batch', suppliedId),
      type: 'batch-plan',
      kind,
      pairs: list(pairs, 'pairs', 100).map((pair) => ({
        from: id(pair?.from, 'pair.from'),
        to: id(pair?.to, 'pair.to'),
      })),
      createdAt: domain.now(),
    };
    return domain.write(documentId, 'workflowRecords', record, options.expectedRevision);
  }

  const snapshot = domain.snapshot(documentId);
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0
    || options.expectedRevision !== snapshot.revision) {
    fail('REVISION_CONFLICT', 'Source-bound batch-plan creation requires the current workspace revision.', 409);
  }

  const source = digest(sourceSha256, 'sourceSha256');
  if (kind !== 'slip-sheet') invalidPlan('Source-bound batch plans must be slip-sheet plans.');
  const normalizedPairs = sourceBoundPairs(pairs);
  const record = {
    id: domain.newId('batch', suppliedId),
    type: 'batch-plan',
    kind,
    pairs: normalizedPairs,
    sourceSha256: source,
    basisRevision: snapshot.revision,
    status: 'planned',
    createdAt: domain.now(),
  };
  return domain.write(documentId, 'workflowRecords', record, options.expectedRevision);
}
