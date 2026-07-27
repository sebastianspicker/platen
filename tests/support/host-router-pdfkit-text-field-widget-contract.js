import test from 'node:test';
import { assert, invoke } from './host-router-fixture.js';
import { createDocumentRoute, postJson } from './host-router-pdfkit-fixture.js';

const profile = 'macos-pdfkit-acroform-text-field-widget-v1';

test('text-field widget route binds its fixed profile, source, body, and processing signal', async (context) => {
  const route = await createDocumentRoute(context, {
    label: 'PDFKIT TEXT FIELD WIDGET', suffix: 'pdfkit-text-field-widget',
  });
  const body = {
    profile,
    sourceSha256: route.document.sha256,
    page: 1,
    rect: { x: 36, y: 36, width: 180, height: 24 },
    fieldName: 'Account.Name',
    defaultValue: 'Local value',
  };
  const bootstrap = JSON.parse((await invoke(route.handler, { url: '/api/bootstrap' })).body);
  assert.equal(bootstrap.host.pdfkitTextFieldWidgetReady, true);

  const response = await postJson(route.handler, route.url, body);
  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).result.artifact.id, 'text-field-widget');
  assert.equal(route.pdfkitTextFieldWidget.calls.length, 1);
  const call = route.pdfkitTextFieldWidget.calls[0];
  assert.equal(call.documentId, route.document.id);
  assert.deepEqual({ ...call.request, signal: undefined }, {
    sourceSha256: route.document.sha256,
    page: 1,
    rect: body.rect,
    fieldName: body.fieldName,
    defaultValue: body.defaultValue,
    signal: undefined,
  });
  assert(call.request.signal instanceof AbortSignal);

  for (const invalid of [
    { ...body, profile: 'custom' },
    { ...body, sourceSha256: 'A'.repeat(64) },
    { ...body, path: '/tmp/field.pdf' },
  ]) {
    const rejected = await postJson(route.handler, route.url, invalid);
    assert.equal(rejected.statusCode, 400);
    assert.equal(JSON.parse(rejected.body).error.code, 'INVALID_PDFKIT_TEXT_FIELD_WIDGET_OPTIONS');
  }
  assert.equal(route.pdfkitTextFieldWidget.calls.length, 1);
});

test('text-field widget route and bootstrap stay unavailable without the optional service', async (context) => {
  const route = await createDocumentRoute(context, {
    fixtureOptions: { pdfkitTextFieldWidgetEnabled: false },
    label: 'PDFKIT TEXT FIELD WIDGET UNAVAILABLE', suffix: 'pdfkit-text-field-widget',
  });
  const bootstrap = JSON.parse((await invoke(route.handler, { url: '/api/bootstrap' })).body);
  assert.equal(bootstrap.host.pdfkitTextFieldWidgetReady, false);
  const response = await postJson(route.handler, route.url, {
    profile,
    sourceSha256: route.document.sha256,
    page: 1,
    rect: { x: 36, y: 36, width: 180, height: 24 },
    fieldName: 'Name',
    defaultValue: null,
  });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, 'PDFKIT_TEXT_FIELD_WIDGET_UNAVAILABLE');
});
