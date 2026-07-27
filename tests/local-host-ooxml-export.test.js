import assert from 'node:assert/strict';
import test from 'node:test';
import { createOoxmlExportEndpoints } from '../src/core/local-host-ooxml-export-endpoints.js';

test('OOXML export client endpoint sends the exact source-bound request', async () => {
  const calls = [];
  const endpoint = createOoxmlExportEndpoints({ json: async (...args) => { calls.push(args); return { result: { kind: 'pdf-ooxml-export' } }; } });
  const documentId = '11111111-1111-4111-8111-111111111111';
  const sourceSha256 = 'a'.repeat(64);
  assert.deepEqual(await endpoint.exportOoxml(documentId, { profile: 'local-pdf-ooxml-export-v1', sourceSha256, format: 'word' }), { kind: 'pdf-ooxml-export' });
  assert.equal(calls[0][0], `/api/documents/${documentId}/export-ooxml`);
  assert.deepEqual(JSON.parse(calls[0][1].body), { profile: 'local-pdf-ooxml-export-v1', sourceSha256, format: 'word' });
  assert.throws(() => endpoint.exportOoxml(documentId, { profile: 'local-pdf-ooxml-export-v1', sourceSha256, format: 'docx' }), TypeError);
  assert.throws(() => endpoint.exportOoxml('../escape', { profile: 'local-pdf-ooxml-export-v1', sourceSha256, format: 'word' }), TypeError);
});
