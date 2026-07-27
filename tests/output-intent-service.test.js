import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { inspectCmykOutputProfile } from '../scripts/host/icc-profile-provider.mjs';
import { OUTPUT_INTENT_PROFILE } from '../scripts/host/prepress/output-intent-contract.mjs';
import { createOutputIntentOperation } from '../scripts/host/prepress/output-intent-service.mjs';
import { PrepressServiceCore } from '../scripts/host/prepress/prepress-service-core.mjs';
import { makeTextPdf } from './pdf-fixture.js';

function cmykProfile(description = 'Fixture CMYK Profile') {
  const name = Buffer.from(`${description}\0`, 'ascii');
  const tagOffset = 144;
  const tagSize = 12 + name.length;
  const bytes = Buffer.alloc(tagOffset + tagSize);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes[8] = 2;
  bytes[9] = 0x20;
  bytes.write('prtr', 12, 'ascii');
  bytes.write('CMYK', 16, 'ascii');
  bytes.write('Lab ', 20, 'ascii');
  bytes.write('acsp', 36, 'ascii');
  bytes.writeUInt32BE(1, 64);
  bytes.writeUInt32BE(1, 128);
  bytes.write('desc', 132, 'ascii');
  bytes.writeUInt32BE(tagOffset, 136);
  bytes.writeUInt32BE(tagSize, 140);
  bytes.write('desc', tagOffset, 'ascii');
  bytes.writeUInt32BE(name.length, tagOffset + 8);
  name.copy(bytes, tagOffset + 12);
  return bytes;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('OutputIntent service promotes through the validating store with standard provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-output-intent-service-'));
  const store = await new DocumentStore({ root }).initialize();
  test.after(() => store.dispose());

  const sourceBytes = makeTextPdf('OutputIntent provenance regression');
  const document = await store.createDocument({
    stream: Readable.from([sourceBytes]),
    displayName: 'source.pdf',
  });
  const profileBytes = cmykProfile();
  const profile = inspectCmykOutputProfile(profileBytes);
  const pageBoxes = [{
    page: 1,
    rotation: 0,
    boxes: {
      mediaBox: { left: 0, bottom: 0, right: 612, top: 792, width: 612, height: 792 },
      cropBox: { left: 0, bottom: 0, right: 612, top: 792, width: 612, height: 792 },
    },
  }];
  const core = new PrepressServiceCore({
    store,
    pdfService: {
      inspect: async () => ({ pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none' }),
      inspectPage: async () => ({}),
      inspectStructure: async () => ({
        sourceDigest: document.sha256,
        pageRange: { firstPage: 1, lastPage: 1, truncated: false },
        pageBoxes,
      }),
    },
    poppler: { execute: async () => ({}) },
    ghostscript: { execute: async () => ({}), probe: async () => ({}) },
    imageMagick: { execute: async () => ({}) },
    iccProfileProvider: {
      stageDefaultCmyk: async (workspace) => {
        const path = join(workspace, 'default-cmyk.icc');
        await writeFile(path, profileBytes, { flag: 'wx', mode: 0o400 });
        return Object.freeze({ path, descriptor: profile });
      },
    },
  });
  core.validateDerivedPdf = async ({ outputPath }) => {
    const outputBytes = await readFile(outputPath);
    return Object.freeze({
      outputSha256: sha256(outputBytes),
      pageCount: 1,
      textSha256: sha256(Buffer.from('OutputIntent provenance regression', 'utf8')),
    });
  };

  const result = await createOutputIntentOperation(core)(document.id, {
    profile: OUTPUT_INTENT_PROFILE,
    sourceSha256: document.sha256,
  });
  const retained = store.getArtifact(result.artifact.id);

  assert.equal(retained.sha256, result.receipt.outputSha256);
  assert.equal(retained.operation.schemaVersion, 1);
  assert.equal(retained.operation.type, 'ghostscript-cmyk-output-intent');
  assert.deepEqual(retained.operation.inputs, [{
    documentId: document.id,
    sha256: document.sha256,
    role: 'source',
  }]);
  assert.equal(retained.operation.parameters.profileId, profile.id);
  assert.equal(retained.operation.parameters.profileSha256, profile.sha256);
  assert.equal(retained.operation.expected.outputIntentCount, 1);
  assert.equal(retained.operation.validation.outputSha256, retained.sha256);
  assert.equal(retained.operation.validation.profileSha256, profile.sha256);
  assert.equal(retained.operation.validation.passed, true);
});
