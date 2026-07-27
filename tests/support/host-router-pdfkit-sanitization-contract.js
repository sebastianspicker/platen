import test from 'node:test';
import { assert } from './host-router-fixture.js';
import {
  createDocumentRoute,
  postJson,
  sourceSha256,
} from './host-router-pdfkit-fixture.js';

const body = { profile: 'macos-pdfkit-metadata-sanitize-v1', sourceSha256 };

test('metadata-sanitization route is exact, authenticated, and fixed-profile only', async (context) => {
  const route = await createDocumentRoute(context, {
    label: 'PDFKIT METADATA SANITIZATION', suffix: 'sanitization',
  });
  const valid = await postJson(route.handler, route.url, body);
  assert.equal(valid.statusCode, 201);
  assert.equal(JSON.parse(valid.body).result.artifact.id, 'metadata-sanitized');
  assert.equal(route.pdfkitSanitization.calls.length, 1);
  assert.equal(route.pdfkitSanitization.calls[0].documentId, route.document.id);
  assert.equal(route.pdfkitSanitization.calls[0].options.sourceSha256, sourceSha256);
  assert(route.pdfkitSanitization.calls[0].options.signal instanceof AbortSignal);

  for (const [invalid, status] of [
    [{ ...body, extra: true }, 400], [{ ...body, profile: 'custom' }, 400],
    [{ ...body, sourceSha256: 'C'.repeat(64) }, 400],
    [{ ...body, padding: 'x'.repeat(2_048) }, 413],
  ]) assert.equal((await postJson(route.handler, route.url, invalid)).statusCode, status);
  assert.equal((await postJson(route.handler, `${route.url}?unsafe=true`, body)).statusCode, 400);
  const noAuth = { origin: route.headers.origin, 'content-type': 'application/json' };
  assert.equal((await postJson(route.handler, route.url, body, noAuth)).statusCode, 401);
});

test('metadata-sanitization route stays unavailable without the pinned helper', async (context) => {
  const route = await createDocumentRoute(context, {
    fixtureOptions: { pdfkitSanitizationEnabled: false },
    label: 'PDFKIT', suffix: 'sanitization',
  });
  const response = await postJson(route.handler, route.url, body);
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, 'PDFKIT_SANITIZATION_UNAVAILABLE');
});
