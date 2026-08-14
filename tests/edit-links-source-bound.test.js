import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildClassicPassivePdf } from '../scripts/host/professional-capability/classic-structure-pdf.mjs';
import { handlers } from '../scripts/host/professional-capability/content-editing.mjs';

const source = buildClassicPassivePdf({ pages: 2 });
const sourceSha256 = createHash('sha256').update(source).digest('hex');

test('edit.links requires explicit source bytes and caller-bound digest', async () => {
  await assert.rejects(
    () => handlers['edit.links']({ sourceSha256, fromPage: 1, toPage: 1 }),
    { code: 'INVALID_PROFESSIONAL_INPUT' },
  );
});

test('edit.links rejects a caller-supplied digest that does not match source bytes', async () => {
  await assert.rejects(
    () => handlers['edit.links']({ sourcePdf: source, sourceSha256: '0'.repeat(64), fromPage: 1, toPage: 1 }),
    { code: 'SOURCE_VERSION_MISMATCH' },
  );
});

test('edit.links rejects malformed source bytes, coordinates, and page bounds', async () => {
  const malformed = Buffer.from('not a pdf', 'utf8');
  const malformedSha256 = createHash('sha256').update(malformed).digest('hex');
  await assert.rejects(
    () => handlers['edit.links']({ sourcePdf: malformed, sourceSha256: malformedSha256, fromPage: 1, toPage: 1 }),
    { code: 'UNSUPPORTED_INCREMENTAL_GOTO_LINK_PDF' },
  );
  await assert.rejects(
    () => handlers['edit.links']({
      sourcePdf: source,
      sourceSha256,
      fromPage: 1,
      toPage: 1,
      rect: { left: 180, bottom: 700, right: 120, top: 760 },
    }),
    { code: 'INVALID_INCREMENTAL_GOTO_LINK' },
  );
  await assert.rejects(
    () => handlers['edit.links']({
      sourcePdf: source,
      sourceSha256,
      fromPage: 0,
      toPage: 1,
      rect: { left: 72, bottom: 700, right: 120, top: 760 },
    }),
    { code: 'INVALID_INCREMENTAL_GOTO_LINK' },
  );
});

test('edit.links applies a source-bound internal GoTo link and returns output/source digests', async () => {
  const outcome = await handlers['edit.links']({
    sourcePdf: source,
    sourceSha256,
    fromPage: 1,
    toPage: 1,
    rect: { left: 72, bottom: 700, right: 200, top: 760 },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sourceSha256, sourceSha256);
  assert.equal(outcome.linkApplied, true);
  assert.equal(typeof outcome.outputSha256, 'string');
  assert.equal(outcome.outputSha256.length, 64);
  assert.equal(outcome.outputSha256, createHash('sha256').update(outcome.pdf).digest('hex'));
  assert.equal(outcome.proof.sourceSha256, sourceSha256);
  assert.equal(outcome.proof.outputSha256, outcome.outputSha256);
  assert.equal(outcome.proof.sourceBytes, source.length);
  assert.equal(outcome.proof.outputBytes, outcome.pdf.length);
  const latin1 = outcome.pdf.toString('latin1');
  assert.equal(latin1.includes('/Subtype /Link') || latin1.includes('/Subtype/Link'), true);
  assert.equal(latin1.includes('/Annots'), true);
});
