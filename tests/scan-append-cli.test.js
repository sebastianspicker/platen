import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runScanAppendCommand } from '../scripts/cli/commands/scan-append.mjs';
import { PDF_COPY_PAGE_PROFILE } from '../scripts/host/pdf-copy-page-contract.mjs';

const primary = { id: '123e4567-e89b-42d3-a456-426614174000', sha256: 'a'.repeat(64) };
const assetId = '123e4567-e89b-42d3-a456-426614174001';
const convertedId = '123e4567-e89b-42d3-a456-426614174002';
const artifactId = '123e4567-e89b-42d3-a456-426614174003';
const ORIGINAL_IMAGE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const command = () => parseCliArguments(['scan-append', 'primary.pdf', 'scan.png', '--after-page', '0', '--output', 'out.pdf']);

function records(image = Buffer.from(ORIGINAL_IMAGE)) {
  const imageSha256 = createHash('sha256').update(image).digest('hex');
  const asset = { id: assetId, displayName: 'scan.png', mediaType: 'image/png', extension: '.png', size: image.length, sha256: imageSha256 };
  const converted = { id: convertedId, displayName: 'scan.pdf', mediaType: 'application/pdf', size: 20, sha256: 'b'.repeat(64), operation: { inputs: [{ assetId, sha256: imageSha256 }], validation: { passed: true, pageCount: 1 } } };
  const artifact = { id: artifactId, documentId: primary.id, mediaType: 'application/pdf', size: 30, sha256: 'c'.repeat(64), filePath: '/private/scan-output.pdf' };
  return { asset, converted, artifact };
}

function applicationFixture({ converted = null, copied = null, cleanup = {}, imageBytes = Buffer.from(ORIGINAL_IMAGE) } = {}) {
  const value = records(imageBytes); converted ??= value.converted; copied ??= value.artifact; const events = [];
  const application = {
    inputs: { createInput: async (request) => { events.push(['create', request]); return value.asset; }, getInput: (id) => { events.push(['get-input', id]); return value.asset; }, verifyInput: async (id) => events.push(['verify', id]), deleteInput: async (id) => { events.push(['delete-input', id]); if (cleanup.input) throw cleanup.input; } },
    conversion: { convertInput: async (id) => { events.push(['convert', id]); return converted; } },
    service: { copyPageBetweenDocuments: async (id, secondary, request) => { events.push(['copy', id, secondary, request]); return copied; } },
    store: { getDocument: (id) => { events.push(['get-document', id]); return converted; }, getArtifact: (id) => { events.push(['get-artifact', id]); return value.artifact; }, deleteDocument: async (id) => { events.push(['delete-document', id]); if (cleanup.document) throw cleanup.document; }, deleteArtifact: async (id) => { events.push(['delete-artifact', id]); if (cleanup.artifact) throw cleanup.artifact; } },
  };
  return { application, events, imageBytes };
}

function runtimeFixture(imageBytes, events, { cancelAt = null, writeError = null } = {}) {
  let checks = 0;
  return { cancelled: () => { checks += 1; if (cancelAt === checks) { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; throw error; } }, canonicalOutputTarget: async (path) => events.push(['canonical', path]), readLocalInputBytes: async () => ({ bytes: imageBytes, displayName: 'scan.png' }), copyExclusive: async (...args) => { events.push(['copy-output', ...args]); if (writeError) throw writeError; }, emit: async (_stdout, value) => events.push(['emit', value]), fail: (code, message) => { const error = new Error(message); error.code = code; throw error; } };
}

test('scan-append parser binds two local inputs and bounded insertion position', () => {
  assert.deepEqual(command(), { command: 'scan-append', input: 'primary.pdf', scan: 'scan.png', extension: '.png', afterPage: 0, output: 'out.pdf' });
  for (const args of [
    ['scan.bmp', '--after-page', '1'],
    ['scan.png', '--after-page', '-1'],
    ['scan.png', '--after-page', '10001'],
    ['scan.pdf', '--after-page', '1'],
    ['scan.png', '--after-page', '1', '--output', 'out.png'],
  ]) assert.throws(() => parseCliArguments(['scan-append', 'primary.pdf', ...args, ...(args.includes('--output') ? [] : ['--output', 'out.pdf'])]), { code: 'CLI_INVALID_OPTION' });
});

test('scan-append converts one validated image page, copies it with both source digests, publishes, and cleans every trusted temporary resource', async () => {
  const fixture = applicationFixture(); const runtime = runtimeFixture(fixture.imageBytes, fixture.events);
  await runScanAppendCommand(fixture.application, command(), primary, null, undefined, runtime);
  const copy = fixture.events.find(([kind]) => kind === 'copy');
  assert.equal(copy[3].profile, PDF_COPY_PAGE_PROFILE);
  assert.equal(copy[3].primarySourceSha256, primary.sha256);
  assert.equal(copy[3].secondarySourceSha256, records().converted.sha256);
  assert.equal(copy[3].sourcePage, 1); assert.equal(copy[3].afterPage, 0); assert.equal(Object.isFrozen(copy[3]), true);
  assert.deepEqual(fixture.events.filter(([kind]) => kind.startsWith('delete-')).map(([kind]) => kind), ['delete-input', 'delete-document', 'delete-artifact']);
  assert.deepEqual(fixture.imageBytes, Buffer.alloc(fixture.imageBytes.length));
  assert.equal(fixture.events.at(-1)[0], 'delete-artifact');
});

test('scan-append rejects forged conversion or composition records without deleting untrusted IDs', async () => {
  const forgedConversion = applicationFixture({ converted: { ...records().converted, operation: { inputs: [{ assetId: '123e4567-e89b-42d3-a456-426614174099', sha256: 'd'.repeat(64) }], validation: { passed: true, pageCount: 1 } } } });
  await assert.rejects(runScanAppendCommand(forgedConversion.application, command(), primary, null, undefined, runtimeFixture(forgedConversion.imageBytes, forgedConversion.events)), { code: 'CLI_INVALID_SCAN_OUTPUT' });
  assert.equal(forgedConversion.events.some(([kind]) => kind === 'delete-document'), false);
  const forgedArtifact = applicationFixture({ copied: { ...records().artifact, documentId: '123e4567-e89b-42d3-a456-426614174099' } });
  await assert.rejects(runScanAppendCommand(forgedArtifact.application, command(), primary, null, undefined, runtimeFixture(forgedArtifact.imageBytes, forgedArtifact.events)), { code: 'CLI_INVALID_SCAN_OUTPUT' });
  assert.equal(forgedArtifact.events.some(([kind]) => kind === 'delete-artifact'), false);
  assert.deepEqual(forgedArtifact.events.filter(([kind]) => kind.startsWith('delete-')).map(([kind]) => kind), ['delete-input', 'delete-document']);
});

test('scan-append cancellation at conversion and publication cleans trusted resources and emits nothing', async () => {
  const conversion = applicationFixture();
  await assert.rejects(runScanAppendCommand(conversion.application, command(), primary, null, undefined, runtimeFixture(conversion.imageBytes, conversion.events, { cancelAt: 2 })), { code: 'JOB_CANCELLED' });
  assert.deepEqual(conversion.events.filter(([kind]) => kind.startsWith('delete-')).map(([kind]) => kind), ['delete-input']);
  const publication = applicationFixture(); const writeError = Object.assign(new Error('cancelled during output'), { code: 'JOB_CANCELLED' });
  await assert.rejects(runScanAppendCommand(publication.application, command(), primary, null, undefined, runtimeFixture(publication.imageBytes, publication.events, { writeError })), { code: 'JOB_CANCELLED' });
  assert.equal(publication.events.some(([kind]) => kind === 'emit'), false);
  assert.deepEqual(publication.events.filter(([kind]) => kind.startsWith('delete-')).map(([kind]) => kind), ['delete-input', 'delete-document', 'delete-artifact']);
});

test('scan-append aggregates cleanup failures without masking the primary conversion error', async () => {
  const fixture = applicationFixture({ cleanup: { document: Object.assign(new Error('cleanup failed'), { code: 'CLEANUP_FAILED' }) } });
  const error = Object.assign(new Error('composition failed'), { code: 'COMPOSITION_FAILED' });
  fixture.application.service.copyPageBetweenDocuments = async () => { throw error; };
  await assert.rejects(runScanAppendCommand(fixture.application, command(), primary, null, undefined, runtimeFixture(fixture.imageBytes, fixture.events)), (value) => value instanceof AggregateError && value.errors[0] === error && value.errors[1].code === 'CLEANUP_FAILED');
});
