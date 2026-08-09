import assert from 'node:assert/strict';
import test from 'node:test';
import { colorOutputIntents } from '../scripts/host/professional-capability/standards-preflight-color.mjs';

test('OutputIntent rejects caller-forged prepress and print-authority objects', async () => {
  await assert.rejects(
    () => colorOutputIntents({
      documentId: 'document-1',
      sourceSha256: 'a'.repeat(64),
      prepress: { async assignOutputIntent() { throw new Error('must not run'); } },
      printAuthority: { store: {}, prepress: {} },
    }),
    { code: 'INVALID_PRODUCTION_AUTHORITY', status: 503 },
  );
});
