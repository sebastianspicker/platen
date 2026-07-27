import test from 'node:test';
import { assert } from './host-router-fixture.js';
import {
  createDocumentRoute,
  postJson,
  sourceSha256,
} from './host-router-pdfkit-fixture.js';

const protection = {
  permissionsProfile: 'accessibility-only',
  ownerPassword: 'Owner-Pass-123', userPassword: 'User-Pass-4567',
};
const protectionBody = { profile: 'macos-pdfkit-aes128-v1', sourceSha256, protection };

const removal = {
  artifactId: '22222222-2222-4222-8222-222222222222',
  artifactSha256: 'd'.repeat(64), ownerPassword: 'Owner-Pass-123',
};
const removalBody = {
  profile: 'macos-pdfkit-remove-protection-v1', sourceSha256, removal,
};

test('PDFKit protection route is exact, bounded, and never returns passwords', async (context) => {
  const route = await createDocumentRoute(context, {
    label: 'PDFKIT PROTECTION', suffix: 'pdfkit-protection',
  });
  const valid = await postJson(route.handler, route.url, protectionBody);
  assert.equal(valid.statusCode, 201);
  assert.equal(JSON.parse(valid.body).result.artifact.id, 'protected');
  assert.doesNotMatch(valid.body.toString(), /Owner-Pass-123|User-Pass-4567/);
  assert.deepEqual(route.pdfkitProtection.calls[0].protection, protection);
  assert.equal(route.pdfkitProtection.calls[0].options.sourceSha256, sourceSha256);
  assert(route.pdfkitProtection.calls[0].options.signal instanceof AbortSignal);

  for (const [body, status] of [
    [{ ...protectionBody, extra: true }, 400],
    [{ ...protectionBody, profile: 'custom' }, 400],
    [{ ...protectionBody, protection: { ...protection, extra: true } }, 400],
    [{ ...protectionBody, sourceSha256: 'C'.repeat(64) }, 400],
    [{ ...protectionBody, padding: 'x'.repeat(2_048) }, 413],
  ]) assert.equal((await postJson(route.handler, route.url, body)).statusCode, status);
  assert.equal((await postJson(route.handler, `${route.url}?unsafe=true`, protectionBody)).statusCode, 400);
  const noAuth = { origin: route.headers.origin, 'content-type': 'application/json' };
  assert.equal((await postJson(route.handler, route.url, protectionBody, noAuth)).statusCode, 401);
});

test('PDFKit protection-removal route is exact and never returns its credential', async (context) => {
  const route = await createDocumentRoute(context, {
    label: 'PDFKIT REMOVAL', suffix: 'pdfkit-protection-removal',
  });
  const valid = await postJson(route.handler, route.url, removalBody);
  assert.equal(valid.statusCode, 201);
  assert.equal(JSON.parse(valid.body).result.artifact.id, 'unprotected');
  assert.doesNotMatch(valid.body.toString(), /Owner-Pass-123/);
  assert.deepEqual(route.pdfkitProtection.removalCalls[0].removal, removal);
  assert.equal(route.pdfkitProtection.removalCalls[0].options.sourceSha256, sourceSha256);
  assert(route.pdfkitProtection.removalCalls[0].options.signal instanceof AbortSignal);
  for (const body of [
    { ...removalBody, extra: true }, { ...removalBody, profile: 'custom' },
    { ...removalBody, removal: { ...removal, extra: true } },
    { ...removalBody, sourceSha256: 'C'.repeat(64) },
  ]) assert.equal((await postJson(route.handler, route.url, body)).statusCode, 400);
});

for (const scenario of [
  {
    name: 'protection', suffix: 'pdfkit-protection',
    body: protectionBody, code: 'PDFKIT_PROTECTION_UNAVAILABLE',
  },
  {
    name: 'protection-removal', suffix: 'pdfkit-protection-removal',
    body: removalBody, code: 'PDFKIT_PROTECTION_REMOVAL_UNAVAILABLE',
  },
]) {
  test(`PDFKit ${scenario.name} route stays unavailable without the pinned helper`, async (context) => {
    const route = await createDocumentRoute(context, {
      fixtureOptions: { pdfkitProtectionEnabled: false },
      label: 'PDFKIT', suffix: scenario.suffix,
    });
    const response = await postJson(route.handler, route.url, scenario.body);
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).error.code, scenario.code);
  });
}
