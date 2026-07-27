import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizePdfObjectDeletion,
  planClassicObjectDeletionTransaction,
  planClassicObjectTransaction,
  planPdfObjectDeletionTransaction,
} from '../scripts/host/pdf-classic-object-transaction.mjs';
import {
  verifyClassicDeletionIncrementalRevision,
  verifyPdfDeletionIncrementalRevision,
} from '../scripts/host/pdf-incremental-deletion-revision.mjs';
import {
  parseClassicPdfStructure,
  parsePdfStructure,
  resolveClassicPdfObject,
  resolvePdfObject,
} from '../scripts/host/pdf-classic-structure.mjs';
import {
  makeObjectStreamPdf,
} from './support/pdf-xref-stream-fixture.js';
import {
  array,
  classicFixture,
  deletionRequest,
  dict,
  freeListFixture,
  mutateTargetBody,
  name,
  orphanedPermanentFreeFixture,
  ref,
  validXrefStreamSource,
} from './support/pdf-object-deletion-fixture.js';

test('classic deletion appends an exact free chain alongside an update and addition', () => {
  const source = classicFixture({ targetGeneration: 2 });
  const structure = parseClassicPdfStructure(source);
  const deletion = authorizePdfObjectDeletion(structure, ref(3, 2));
  const plan = planClassicObjectDeletionTransaction(deletionRequest(
    source,
    structure,
    [deletion],
    {
      updates: [{ reference: ref(4), value: dict([['Kind', name('Survivor')]]) }],
      additions: [{ id: 'added', value: dict([['Owner', ref(4)]]) }],
    },
  ));

  assert.deepEqual(plan.referencesById.added, ref(5));
  assert.equal(plan.effectiveSize, 6);
  assert.deepEqual(plan.deletionSummary, {
    count: 1, freeListHeadBefore: 0, freeListHeadAfter: 3,
  });
  assert.match(plan.revision.bytes.toString('latin1'), /xref\n0 1\n0000000003 65535 f \n3 3\n0000000000 00003 f /u);
  const outputBytes = Buffer.concat([source, plan.revision.bytes]);
  const proof = verifyClassicDeletionIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: plan.revision,
  });
  assert.equal(proof.freeListVerified, true);
  assert.equal(proof.objectsLogicallyDeleted, 1);
  assert.equal(proof.freeRowsAppended, 2);
  assert.equal(proof.outputStructure.effective.get(0).offset, 3);
  assert.deepEqual(proof.outputStructure.effective.get(3), {
    object: 3, generation: 3, offset: 0, status: 'f',
  });
  assert.equal(resolveClassicPdfObject(
    proof.outputStructure, ref(4),
  ).value.entries.get('Kind').value, 'Survivor');
  assert.equal(resolveClassicPdfObject(
    proof.outputStructure, plan.referencesById.added,
  ).value.entries.get('Owner').object, 4);
  assert.throws(() => resolveClassicPdfObject(proof.outputStructure, ref(3, 2)), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
  assert.equal(outputBytes.subarray(0, source.length).equals(source), true);
  assert.equal(outputBytes.subarray(0, source.length).includes(
    Buffer.from('3 2 obj\n<< /Kind /Target >>', 'latin1'),
  ), true);
});

test('deletion validates the post-transaction graph and ignores outgoing references of deleted objects', () => {
  const source = classicFixture();
  const structure = parseClassicPdfStructure(source);
  const target = authorizePdfObjectDeletion(structure, ref(3));
  assert.throws(() => planClassicObjectDeletionTransaction(
    deletionRequest(source, structure, [target]),
  ), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });

  const mutualSource = classicFixture({
    objectThree: '<< /Peer 4 0 R >>',
    objectFour: '<< /Peer 3 0 R >>',
  });
  const mutual = parseClassicPdfStructure(mutualSource);
  const plan = planClassicObjectDeletionTransaction(deletionRequest(mutualSource, mutual, [
    authorizePdfObjectDeletion(mutual, ref(4)),
    authorizePdfObjectDeletion(mutual, ref(3)),
  ]));
  const proof = verifyClassicDeletionIncrementalRevision({
    sourceBytes: mutualSource,
    outputBytes: Buffer.concat([mutualSource, plan.revision.bytes]),
    sourceStructure: mutual,
    expectedRevision: plan.revision,
  });
  assert.equal(proof.objectsLogicallyDeleted, 2);
  assert.deepEqual(plan.revision.deletions.map(({ reference }) => reference.object), [3, 4]);
  assert.equal(proof.outputStructure.effective.get(3).offset, 4);
  assert.equal(proof.outputStructure.effective.get(4).offset, 0);
});

test('newly deleted objects are prepended to an existing valid free chain', () => {
  const source = freeListFixture();
  const structure = parseClassicPdfStructure(source);
  const plan = planClassicObjectDeletionTransaction(deletionRequest(
    source, structure, [authorizePdfObjectDeletion(structure, ref(3))],
  ));
  assert.equal(plan.revision.freeListHeadBefore, 2);
  assert.equal(plan.revision.freeListHeadAfter, 3);
  assert.equal(plan.revision.deletions[0].nextFree, 2);
  const proof = verifyClassicDeletionIncrementalRevision({
    sourceBytes: source,
    outputBytes: Buffer.concat([source, plan.revision.bytes]),
    sourceStructure: structure,
    expectedRevision: plan.revision,
  });
  assert.equal(proof.outputStructure.effective.get(0).offset, 3);
  assert.equal(proof.outputStructure.effective.get(3).offset, 2);
  assert.equal(proof.outputStructure.effective.get(2).offset, 0);
});

test('generation 65534 closes at 65535 while permanent free orphans remain unlinked', () => {
  const maximumSource = classicFixture({
    targetGeneration: 65_534,
    objectFour: '<< /Kind /Survivor >>',
  });
  const maximum = parseClassicPdfStructure(maximumSource);
  const maximumPlan = planClassicObjectDeletionTransaction(deletionRequest(
    maximumSource,
    maximum,
    [authorizePdfObjectDeletion(maximum, ref(3, 65_534))],
  ));
  const maximumProof = verifyClassicDeletionIncrementalRevision({
    sourceBytes: maximumSource,
    outputBytes: Buffer.concat([maximumSource, maximumPlan.revision.bytes]),
    sourceStructure: maximum,
    expectedRevision: maximumPlan.revision,
  });
  assert.equal(maximumProof.outputStructure.effective.get(3).generation, 65_535);

  const orphanSource = orphanedPermanentFreeFixture();
  const orphan = parseClassicPdfStructure(orphanSource);
  const orphanPlan = planClassicObjectDeletionTransaction(deletionRequest(
    orphanSource, orphan, [authorizePdfObjectDeletion(orphan, ref(3))],
  ));
  const orphanProof = verifyClassicDeletionIncrementalRevision({
    sourceBytes: orphanSource,
    outputBytes: Buffer.concat([orphanSource, orphanPlan.revision.bytes]),
    sourceStructure: orphan,
    expectedRevision: orphanPlan.revision,
  });
  assert.equal(orphanProof.outputStructure.effective.get(0).offset, 3);
  assert.equal(orphanProof.outputStructure.effective.get(3).offset, 0);
  assert.deepEqual(orphanProof.outputStructure.effective.get(2), {
    object: 2, generation: 65_535, offset: 0, status: 'f',
  });
});

test('deletion rejects unsafe targets, forged authority, signatures, and malformed free lists', () => {
  const source = classicFixture();
  const structure = parseClassicPdfStructure(source);
  assert.throws(() => authorizePdfObjectDeletion(structure, ref(1)), {
    code: 'INVALID_INCREMENTAL_PDF_DELETION',
  });
  const infoSource = Buffer.from(source.toString('latin1').replace(
    '/Size 5 /Root 1 0 R >>', '/Size 5 /Root 1 0 R /Info 4 0 R >>',
  ), 'latin1');
  const infoStructure = parseClassicPdfStructure(infoSource);
  assert.throws(() => authorizePdfObjectDeletion(infoStructure, ref(4)), {
    code: 'INVALID_INCREMENTAL_PDF_DELETION',
  });
  assert.throws(() => planClassicObjectDeletionTransaction(
    deletionRequest(source, structure, [{}]),
  ), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
  const handle = authorizePdfObjectDeletion(structure, ref(3));
  assert.throws(() => planClassicObjectDeletionTransaction(deletionRequest(
    source, structure, [handle], {
      updates: [{ reference: ref(3), value: dict([]) }],
    },
  )), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
  assert.throws(() => planClassicObjectDeletionTransaction(deletionRequest(
    source, structure, [handle], {
      additions: [{ id: 'dangling', value: dict([['Target', ref(3, 99)]]) }],
    },
  )), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });

  const signedSource = classicFixture({ objectFour: '<< /Type /Sig >>' });
  const signed = parseClassicPdfStructure(signedSource);
  assert.throws(() => planClassicObjectDeletionTransaction(deletionRequest(
    signedSource, signed, [authorizePdfObjectDeletion(signed, ref(3))],
  )), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });

  const malformed = freeListFixture({ loop: true });
  const malformedStructure = parseClassicPdfStructure(malformed);
  assert.throws(() => authorizePdfObjectDeletion(malformedStructure, ref(3)), {
    code: 'INVALID_INCREMENTAL_PDF_DELETION',
  });
});

test('historical and planned signature evidence blocks logical deletion', () => {
  const signedSource = classicFixture({ objectFour: '<< /Type /Sig >>' });
  const signed = parseClassicPdfStructure(signedSource);
  const shadow = planClassicObjectTransaction({
    sourceBytes: signedSource,
    sourceStructure: signed,
    updates: [{ reference: ref(4), value: dict([['Kind', name('Survivor')]]) }],
    additions: [],
    info: { kind: 'preserve' },
    changingId: null,
  });
  const shadowedSource = Buffer.concat([signedSource, shadow.revision.bytes]);
  const shadowed = parseClassicPdfStructure(shadowedSource);
  assert.throws(() => planClassicObjectDeletionTransaction(deletionRequest(
    shadowedSource,
    shadowed,
    [authorizePdfObjectDeletion(shadowed, ref(3))],
  )), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });

  const source = classicFixture({ objectFour: '<< /Kind /Survivor >>' });
  const structure = parseClassicPdfStructure(source);
  for (const value of [
    dict([['ByteRange', array([])]]),
    dict([['FT', name('Sig')]]),
  ]) {
    assert.throws(() => planClassicObjectDeletionTransaction(deletionRequest(
      source,
      structure,
      [authorizePdfObjectDeletion(structure, ref(3))],
      { updates: [{ reference: ref(4), value }] },
    )), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
  }
});

test('generic xref-stream deletion appends a classic free row and preserves its control object', () => {
  const source = validXrefStreamSource();
  const structure = parsePdfStructure(source);
  assert.throws(() => authorizePdfObjectDeletion(structure, ref(7)), {
    code: 'INVALID_INCREMENTAL_PDF_DELETION',
  });
  structure.controlObjectNumbers.clear();
  assert.throws(() => authorizePdfObjectDeletion(structure, ref(7)), {
    code: 'INVALID_INCREMENTAL_PDF_DELETION',
  });
  const deletion = authorizePdfObjectDeletion(structure, ref(6));
  const page = resolvePdfObject(structure, ref(5)).value;
  const updatedPage = dict([...page.entries].filter(([key]) => key !== 'Contents'));
  const plan = planPdfObjectDeletionTransaction(deletionRequest(
    source,
    structure,
    [deletion],
    {
      updates: [{ reference: ref(5), value: updatedPage }],
      additions: [{ id: 'added', value: dict([['Kind', name('Added')]]) }],
    },
  ));
  const outputBytes = Buffer.concat([source, plan.revision.bytes]);
  const proof = verifyPdfDeletionIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: plan.revision,
  });
  assert.equal(proof.sourceXrefFlavor, 'stream');
  assert.equal(proof.appendedXrefFlavor, 'classic');
  assert.equal(proof.outputStructure.controlObjectNumbers.has(7), true);
  assert.equal(proof.outputStructure.effective.get(6).status, 'f');
  assert.equal(resolvePdfObject(
    proof.outputStructure, plan.referencesById.added,
  ).value.entries.get('Kind').value, 'Added');
  assert.throws(() => resolvePdfObject(proof.outputStructure, ref(6)), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
});

test('compressed objects are not eligible and deletion verification rejects substitutions', () => {
  const compressedSource = makeObjectStreamPdf();
  const compressed = parsePdfStructure(compressedSource);
  assert.equal(compressed.effective.get(2).status, 'c');
  assert.throws(() => authorizePdfObjectDeletion(compressed, ref(2)), {
    code: 'INVALID_INCREMENTAL_PDF_DELETION',
  });

  const source = classicFixture();
  const structure = parseClassicPdfStructure(source);
  const plan = planClassicObjectDeletionTransaction(deletionRequest(
    source,
    structure,
    [authorizePdfObjectDeletion(structure, ref(3))],
    { updates: [{ reference: ref(4), value: dict([]) }] },
  ));
  const outputBytes = Buffer.concat([source, plan.revision.bytes]);
  const tampered = Buffer.from(outputBytes);
  tampered[tampered.length - 8] ^= 1;
  const freeRowTampered = Buffer.from(outputBytes);
  const freeRow = Buffer.from('0000000000 00001 f ', 'latin1');
  const freeRowOffset = freeRowTampered.lastIndexOf(freeRow);
  assert.ok(freeRowOffset >= source.length);
  freeRowTampered[freeRowOffset + 9] = 0x31;
  for (const candidate of [tampered, freeRowTampered]) {
    assert.throws(() => verifyClassicDeletionIncrementalRevision({
      sourceBytes: source,
      outputBytes: candidate,
      sourceStructure: structure,
      expectedRevision: plan.revision,
    }), { code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT' });
  }
  assert.throws(() => verifyClassicDeletionIncrementalRevision({
    sourceBytes: source,
    outputBytes,
    sourceStructure: structure,
    expectedRevision: Object.freeze({ ...plan.revision }),
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT' });
});

test('deletion authority rejects exact-buffer mutation before and after planning', () => {
  const staleSource = classicFixture({ objectFour: '<< /Kind /Survivor >>' });
  const staleStructure = parseClassicPdfStructure(staleSource);
  const staleHandle = authorizePdfObjectDeletion(staleStructure, ref(3));
  mutateTargetBody(staleSource);
  assert.throws(() => planClassicObjectDeletionTransaction(deletionRequest(
    staleSource, staleStructure, [staleHandle],
  )), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });

  const source = classicFixture({ objectFour: '<< /Kind /Survivor >>' });
  const structure = parseClassicPdfStructure(source);
  const plan = planClassicObjectDeletionTransaction(deletionRequest(
    source, structure, [authorizePdfObjectDeletion(structure, ref(3))],
  ));
  mutateTargetBody(source);
  assert.throws(() => verifyClassicDeletionIncrementalRevision({
    sourceBytes: source,
    outputBytes: Buffer.concat([source, plan.revision.bytes]),
    sourceStructure: structure,
    expectedRevision: plan.revision,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT' });
});

test('deletion handles cannot cross otherwise identical source structures', () => {
  const firstSource = classicFixture({ objectFour: '<< /Kind /Survivor >>' });
  const secondSource = Buffer.from(firstSource);
  const first = parseClassicPdfStructure(firstSource);
  const second = parseClassicPdfStructure(secondSource);
  const handle = authorizePdfObjectDeletion(first, ref(3));
  assert.throws(() => planClassicObjectDeletionTransaction(deletionRequest(
    secondSource, second, [handle],
  )), { code: 'INVALID_CLASSIC_OBJECT_TRANSACTION' });
});

test('deletion rejects SharedArrayBuffer-backed sources at authorization and verification', () => {
  const source = classicFixture({ objectFour: '<< /Kind /Survivor >>' });
  const shared = Buffer.from(new SharedArrayBuffer(source.length));
  source.copy(shared);
  const sharedStructure = parseClassicPdfStructure(shared);
  assert.throws(() => authorizePdfObjectDeletion(sharedStructure, ref(3)), {
    code: 'INVALID_INCREMENTAL_PDF_DELETION',
  });

  const structure = parseClassicPdfStructure(source);
  const plan = planClassicObjectDeletionTransaction(deletionRequest(
    source, structure, [authorizePdfObjectDeletion(structure, ref(3))],
  ));
  assert.throws(() => verifyClassicDeletionIncrementalRevision({
    sourceBytes: shared,
    outputBytes: Buffer.concat([shared, plan.revision.bytes]),
    sourceStructure: sharedStructure,
    expectedRevision: plan.revision,
  }), { code: 'INVALID_CLASSIC_INCREMENTAL_OUTPUT' });
});
