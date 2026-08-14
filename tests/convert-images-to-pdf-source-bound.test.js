import * as setup from './support/professional-capability-delivery-test-setup.js';

const {
  assert,
  createHash,
  test,
  deliverProfessionalCapability,
  pngFixture,
} = setup;

const sourceSha256 = createHash('sha256').update(pngFixture).digest('hex');

test('convert.images-to-pdf emits a retained, source-bound single-page PDF for valid PNG input', async () => {
  const outcome = await deliverProfessionalCapability('convert.images-to-pdf', {
    sourceBytes: pngFixture,
    sourceSha256,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.mediaType, 'application/pdf');
  assert.equal(outcome.pageCount, 1);
  assert.equal(outcome.sourceSha256, sourceSha256);
  assert.equal(outcome.sha256, createHash('sha256').update(outcome.bytes).digest('hex'));
  assert.equal(outcome.size, outcome.bytes.length);
  assert.equal(outcome.path, 'local-png-xobject');
  assert.match(outcome.bytes.toString('latin1'), /\/Type \/XObject/);
  assert.match(outcome.bytes.toString('latin1'), /\/Count 1/);
});

test('convert.images-to-pdf rejects hostile image inputs and bound mismatches', async () => {
  const malformedPng = createHash('sha256').update('not-a-png').digest('hex');
  await assert.rejects(
    () => deliverProfessionalCapability('convert.images-to-pdf', {
      sourceBytes: Buffer.from('not-a-png', 'utf8'),
      sourceSha256: malformedPng,
    }),
    { code: 'INVALID_RENDER_OUTPUT' },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('convert.images-to-pdf', {
      sourceBytes: pngFixture,
      sourceSha256: '0'.repeat(64),
    }),
    { code: 'SOURCE_VERSION_MISMATCH' },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('convert.images-to-pdf', {
      sourceBytes: pngFixture,
    }),
    { code: 'INVALID_CAPABILITY_INPUT' },
  );
});

test('convert.images-to-pdf rejects pre-cancelled requests and insufficient adapter authority', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    () => deliverProfessionalCapability('convert.images-to-pdf', {
      sourceBytes: pngFixture,
      sourceSha256,
      signal: controller.signal,
    }),
    { code: 'JOB_CANCELLED' },
  );

  await assert.rejects(
    () => deliverProfessionalCapability('convert.images-to-pdf', {
      sourceBytes: pngFixture,
      sourceSha256,
      assetId: 'asset-1',
      conversion: {
        async convertInput() {
          return {
            id: 'doc-1',
            size: 99,
            sha256: 'a'.repeat(64),
            operation: {
              type: 'image-to-pdf',
              inputs: [{ role: 'source', sha256: sourceSha256 }],
            },
          };
        },
      },
    }),
    { code: 'CONVERSION_INSUFFICIENT_SOURCE_BOUND' },
  );
});
