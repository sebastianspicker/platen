import { exactObject, locator } from './pdfkit-mutation-contract-shared.mjs';

export function normalizeLocalGoToRemovalMutation(value, sourceInspection) {
  const input = exactObject(value, new Set(['linkRemoval']), 'mutation');
  const linkRemoval = locator(
    input.linkRemoval,
    new Set(['page', 'annotationIndex', 'fingerprint']),
    sourceInspection.pageCount,
    'mutation.linkRemoval',
  );
  return Object.freeze({
    mutation: Object.freeze({ linkRemoval: Object.freeze(linkRemoval) }),
    editCount: 1,
    targeted: false,
    localGoTo: false,
    localGoToRemoval: true,
    expectedForm: 'none',
  });
}
