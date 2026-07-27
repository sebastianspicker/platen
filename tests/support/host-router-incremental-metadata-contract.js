import test from 'node:test';
import { assert, invoke } from './host-router-fixture.js';
import {
  createDocumentRoute,
  postJson,
  sourceSha256,
} from './host-router-pdfkit-fixture.js';

test('incremental metadata route is exact, authenticated, and fixed-profile only', async (context) => {
  const route = await createDocumentRoute(context, {
    label: 'INCREMENTAL METADATA', suffix: 'incremental-metadata',
  });
  const bootstrap = JSON.parse((await invoke(route.handler, { url: '/api/bootstrap' })).body);
  assert.equal(bootstrap.host.incrementalMetadataReady, true);
  const metadata = {
    title: 'New title', author: null, subject: 'New subject', keywords: null,
  };
  const body = {
    profile: 'local-classic-incremental-metadata-v1', sourceSha256, metadata,
  };
  const valid = await postJson(route.handler, route.url, body);
  assert.equal(valid.statusCode, 201);
  assert.equal(JSON.parse(valid.body).result.artifact.id, 'incremental-metadata');
  assert.deepEqual(route.incrementalMetadata.calls[0].metadata, metadata);
  assert(route.incrementalMetadata.calls[0].options.signal instanceof AbortSignal);

  for (const invalid of [
    { ...body, extra: true },
    { ...body, profile: 'other' },
    { ...body, sourceSha256: 'C'.repeat(64) },
    { ...body, metadata: { ...metadata, creator: 'forbidden' } },
  ]) {
    const response = await postJson(route.handler, route.url, invalid);
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, 'INVALID_INCREMENTAL_METADATA_OPTIONS');
  }
});
