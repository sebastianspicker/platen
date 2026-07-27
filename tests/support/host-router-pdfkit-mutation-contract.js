import test from 'node:test';
import { assert, invoke } from './host-router-fixture.js';
import {
  createDocumentRoute,
  postJson,
  routeHeaders,
  sourceSha256,
} from './host-router-pdfkit-fixture.js';

const derivedMutation = {
  metadata: { title: 'Derived', author: null, subject: null, keywords: null },
  pageBox: null, rotation: null, annotations: [],
};

const request = (profile, mutation) => ({ profile, sourceSha256, mutation });

async function createMutationRoute(context, fixtureOptions) {
  return createDocumentRoute(context, {
    fixtureOptions, label: 'PDFKIT MUTATION', suffix: 'pdfkit-mutation',
  });
}

async function expectAccepted(route, profile, mutation) {
  const response = await postJson(route.handler, route.url, request(profile, mutation));
  assert.equal(response.statusCode, 201);
  const call = route.pdfkitMutations.calls.at(-1);
  assert.deepEqual(call.mutation, mutation);
  assert.equal(call.options.profile, profile);
  return { call, response };
}

test('PDFKit mutation route accepts derived and targeted widget profiles', async (context) => {
  const route = await createMutationRoute(context);
  const { call, response } = await expectAccepted(
    route, 'macos-pdfkit-derived-v1', derivedMutation,
  );
  assert.deepEqual(Object.keys(JSON.parse(response.body)), ['result']);
  assert.equal(JSON.parse(response.body).result.artifact.id, 'derived');
  assert.equal('options' in JSON.parse(response.body).result, false);
  assert.equal(call.options.sourceSha256, sourceSha256);
  assert(call.options.signal instanceof AbortSignal);

  await expectAccepted(route, 'macos-pdfkit-derived-v1', {
    metadata: null, pageBox: null, rotation: null,
    annotations: [{
      page: 1, subtype: 'text', contents: 'Private sticky note',
      rect: { x: 10, y: 10, width: 40, height: 40 },
    }],
  });
  for (const formFill of [
    { page: 1, annotationIndex: 0, fingerprint: 'd'.repeat(64), fieldType: 'text', value: 'private' },
    { page: 1, annotationIndex: 1, fingerprint: 'e'.repeat(64), fieldType: 'button', value: 'on' },
    { page: 1, annotationIndex: 2, fingerprint: 'f'.repeat(64), fieldType: 'choice', value: '' },
  ]) {
    await expectAccepted(route, 'macos-pdfkit-targeted-v1', {
      formFill, annotationUpdate: null, annotationRemove: null,
    });
  }
  await expectAccepted(route, 'macos-pdfkit-derived-v1', {
    metadata: null, pageBox: null, rotation: { page: 1, degrees: 90 }, annotations: [],
  });
});

test('PDFKit mutation route accepts fixed navigation and drawing profiles', async (context) => {
  const route = await createMutationRoute(context);
  const cases = [
    ['macos-pdfkit-local-goto-v1', {
      link: { sourcePage: 1, targetPage: 1, rect: { x: 10, y: 10, width: 80, height: 20 } },
    }],
    ['macos-pdfkit-line-annotation-v1', {
      line: { page: 1, contents: 'private line', start: { x: 10, y: 10 }, end: { x: 90, y: 70 } },
    }],
    ['macos-pdfkit-ink-annotation-v1', {
      ink: {
        page: 1, contents: 'private ink',
        points: [{ x: 10, y: 10 }, { x: 50, y: 35 }, { x: 90, y: 70 }],
      },
    }],
    ['macos-pdfkit-outline-v1', { bookmark: { page: 1, label: 'Appendix' } }],
    ['macos-pdfkit-local-goto-remove-v1', {
      linkRemoval: { page: 1, annotationIndex: 0, fingerprint: 'f'.repeat(64) },
    }],
    ['macos-pdfkit-outline-remove-v1', {
      bookmarkRemoval: { topLevelIndex: 0, fingerprint: 'e'.repeat(64) },
    }],
    ['macos-pdfkit-outline-rename-v1', {
      bookmarkRename: {
        topLevelIndex: 0, fingerprint: 'e'.repeat(64), label: 'Renamed appendix',
      },
    }],
  ];
  for (const [profile, mutation] of cases) await expectAccepted(route, profile, mutation);
});

test('PDFKit mutation route rejects transport and request-envelope drift', async (context) => {
  const route = await createMutationRoute(context);
  const body = request('macos-pdfkit-derived-v1', derivedMutation);
  const cases = [
    [{ headers: { origin: routeHeaders.origin, 'content-type': 'application/json' } }, 401],
    [{ headers: { ...routeHeaders, origin: 'http://attacker.example' } }, 403],
    [{ method: 'GET', headers: { 'x-platen-token': 'test-session-token' } }, 405],
    [{ url: `${route.url}?unsafe=true` }, 400],
    [{ headers: { ...routeHeaders, 'content-type': 'text/plain' } }, 415],
  ];
  for (const [override, status] of cases) {
    const response = await invoke(route.handler, {
      method: 'POST', url: route.url, headers: routeHeaders,
      body: JSON.stringify(body), ...override,
    });
    assert.equal(response.statusCode, status);
  }

  for (const [invalid, status, code] of [
    [{ ...body, path: '/tmp/evil' }, 400, 'INVALID_PDFKIT_MUTATION_OPTIONS'],
    [{ ...body, profile: 'other' }, 400],
    [{ ...body, sourceSha256: 'C'.repeat(64) }, 400],
    [{ ...body, mutation: { ...derivedMutation, padding: 'x'.repeat(8_192) } }, 413],
  ]) {
    const response = await postJson(route.handler, route.url, invalid);
    assert.equal(response.statusCode, status);
    if (code) assert.equal(JSON.parse(response.body).error.code, code);
  }
});

test('PDFKit mutation route stays unavailable without the pinned helper', async (context) => {
  const route = await createMutationRoute(context, { pdfkitMutationEnabled: false });
  const response = await postJson(
    route.handler, route.url, request('macos-pdfkit-derived-v1', {
      metadata: null, pageBox: null, rotation: null, annotations: [],
    }),
  );
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, 'PDFKIT_MUTATION_UNAVAILABLE');
});
