import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOoxmlExportRoute } from '../scripts/host/routes/ooxml-export-routes.mjs';

test('OOXML export route is authenticated by the shared router and returns metadata without bytes', async () => {
  const documentId = '11111111-1111-4111-8111-111111111111';
  const response = {};
  const calls = [];
  const body = { profile: 'local-pdf-ooxml-export-v1', sourceSha256: 'a'.repeat(64), format: 'excel' };
  const handled = await handleOoxmlExportRoute({
    pathname: `/api/documents/${documentId}/export-ooxml`, request: { method: 'POST' }, response, documentId,
    ooxmlExport: { export: async (...args) => { calls.push(args); return { kind: 'pdf-ooxml-export', bytes: Buffer.from('secret bytes'), artifact: { id: 'artifact' } }; } },
    processing: { signal: new AbortController().signal }, method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => body, bodyLimit: 2_048,
    exactJsonObject: (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    json: (target, status, value) => { target.status = status; target.body = value; },
  });
  assert.equal(handled, true);
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.result, { kind: 'pdf-ooxml-export', artifact: { id: 'artifact' } });
  assert.deepEqual(calls[0], [documentId, 'excel', { sourceSha256: body.sourceSha256, signal: calls[0][2]?.signal }]);
});

