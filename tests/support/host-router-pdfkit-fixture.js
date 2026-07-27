import {
  fixture,
  invoke,
  makeTextPdf,
  Readable,
} from './host-router-fixture.js';

export const sourceSha256 = 'c'.repeat(64);

export const routeHeaders = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

export async function createDocumentRoute(context, {
  fixtureOptions,
  label,
  suffix,
}) {
  const configured = await fixture(context, fixtureOptions);
  const document = await configured.store.createDocument({
    stream: Readable.from([makeTextPdf(label)]),
    displayName: 'source.pdf',
  });
  return {
    ...configured,
    document,
    headers: routeHeaders,
    url: `/api/documents/${document.id}/${suffix}`,
  };
}

export function postJson(handler, url, body, headers = routeHeaders) {
  return invoke(handler, {
    method: 'POST',
    url,
    headers,
    body: JSON.stringify(body),
  });
}
