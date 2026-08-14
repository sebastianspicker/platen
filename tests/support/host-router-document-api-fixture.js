import {
  fixture,
  invoke,
  makeTextPdf,
} from './host-router-fixture.js';

export const tokenHeader = {
  'x-platen-token': 'test-session-token',
};

export const authenticatedHeaders = {
  origin: 'http://127.0.0.1:4173',
  ...tokenHeader,
};

export const jsonHeaders = {
  ...authenticatedHeaders,
  'content-type': 'application/json',
};

export async function createUploadedRouterFixture(context) {
  const { handler, store } = await fixture(context);
  const pdf = makeTextPdf();
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: {
      ...authenticatedHeaders,
      'content-type': 'application/pdf',
      'x-document-name': encodeURIComponent('../report.pdf'),
    },
    body: pdf,
  });
  if (response.statusCode !== 201) {
    throw new Error(`Fixture upload failed with status ${response.statusCode}`);
  }
  return {
    document: JSON.parse(response.body).document,
    handler,
    pdf,
    store,
  };
}
