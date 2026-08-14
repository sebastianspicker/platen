import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { deliverProfessionalCapability } from '../scripts/host/professional-capability/index.mjs';

test('viewer document properties bind semantic metadata to the supplied source, not a fixture byte count', async () => {
  const source = Buffer.concat([
    createBlankPdf({ pages: 1, title: 'viewer-property-regression' }),
    Buffer.from('\n% deterministic trailing payload\n', 'latin1'),
  ]);
  const outcome = await deliverProfessionalCapability('viewer.document-properties', {
    sourcePdf: source,
    title: 'Bound document title',
  });

  assert.equal(outcome.method, 'local-viewer-document-properties');
  assert.equal(outcome.sourceSha256, createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(outcome.properties, {
    title: 'Bound document title',
    bytes: source.length,
    producer: 'platen-local',
    encrypted: false,
  });
});
