import { pdfInteger } from './pdf-classic-syntax.mjs';

function sameReference(left, right) { return left?.object === right?.object && left?.generation === right?.generation; }

export function trailerMatches(source, output, expected) {
  if (output.revisions.length !== source.revisions.length + 1
    || output.revisions[0].offset !== expected.xrefOffset
    || pdfInteger(output.revisions[0].trailer.get('Prev')) !== source.revisions[0].offset
    || output.finalSize !== expected.effectiveSize
    || !sameReference(output.root, source.root)
    || !sameReference(output.info, expected.infoReference)) return false;
  return (source.id === null) === (output.id === null) && (!source.id || (
    output.id[0].equals(source.id[0])
    && output.id[1].toString('hex').toUpperCase() === expected.changingIdHex));
}

export function effectiveEntriesMatch(source, output, expected) {
  const changed = new Map(expected.records.map((record) => [record.reference.object, record]));
  const deleted = new Map((expected.deletions ?? []).map((deletion) => (
    [deletion.reference.object, deletion]
  )));
  const additions = new Set(expected.records
    .filter(({ reference }) => reference.object >= source.finalSize)
    .map(({ reference }) => reference.object));
  if (output.effective.size !== source.effective.size + additions.size) return false;
  for (const [number, entry] of source.effective) {
    const next = output.effective.get(number);
    const replacement = changed.get(number);
    const deletion = deleted.get(number);
    if (!next || (number === 0 && expected.deletionCount
      ? next.status !== 'f' || next.generation !== 65_535
        || next.offset !== expected.freeListHeadAfter
      : deletion
        ? next.status !== 'f' || next.generation !== deletion.freeGeneration
          || next.offset !== deletion.nextFree
        : replacement
      ? next.status !== 'n' || next.generation !== replacement.reference.generation
        || next.offset !== replacement.offset
      : next.status !== entry.status || next.generation !== entry.generation
        || (entry.status === 'c'
          ? next.objectStream !== entry.objectStream || next.index !== entry.index
          : next.offset !== entry.offset))) return false;
  }
  return [...output.effective.keys()].every((number) => (
    source.effective.has(number) || additions.has(number)
  ));
}

export function incrementalCompatibilityEvidence(source, expected) {
  return Object.freeze({
    sourceXrefFlavor: source.xrefFlavor,
    appendedXrefFlavor: 'classic',
    compressedObjectsRead: source.compressedObjectVersions ?? 0,
    compressedObjectsRewrittenUncompressed: expected.records.filter(
      ({ reference }) => source.effective.get(reference.object)?.status === 'c',
    ).length,
    ...(expected.deletionCount ? {
      objectsLogicallyDeleted: expected.deletionCount,
      freeRowsAppended: expected.deletionCount + 1,
      compressedObjectsDeleted: 0,
    } : {}),
  });
}
