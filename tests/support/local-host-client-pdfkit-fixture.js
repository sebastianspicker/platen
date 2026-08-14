import {
  assert,
  LocalHostClient,
  token,
} from './local-host-client-fixture.js';
import { pdfKitClientMutationResult } from './pdfkit-client-result-fixture.js';

export const sourceSha256 = 'b'.repeat(64);

export async function createPdfKitClientSession() {
  const calls = [];
  const controller = new AbortController();
  const client = new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
      }
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        result: pdfKitClientMutationResult({
          documentId: 'doc', sourceSha256: request.sourceSha256,
          profile: request.profile, mutation: request.mutation,
        }),
      }), { status: 201 });
    },
  });
  await client.bootstrap();
  return { calls, client, controller };
}

export async function expectPdfKitClientRequest(session, method, profile, mutation) {
  const index = session.calls.length;
  const result = await session.client[method](
    'doc', sourceSha256, mutation, { signal: session.controller.signal },
  );
  const call = session.calls[index];
  assert.equal(call.path, '/api/documents/doc/pdfkit-mutation');
  assert.equal(call.options.signal, session.controller.signal);
  assert.deepEqual(JSON.parse(call.options.body), { profile, sourceSha256, mutation });
  assert.equal(call.options.headers['X-Platen-Token'], token);
  return result;
}
