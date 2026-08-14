import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runProfessionalCapabilityCommand } from '../scripts/cli/commands/professional-capability.mjs';
import { PdfAccessibilityFormSemanticsService } from '../scripts/host/pdf-accessibility-form-semantics-service.mjs';
import { PdfAccessibilityLinksBookmarksService } from '../scripts/host/pdf-accessibility-links-bookmarks-service.mjs';
import { PdfAccessibilityTableSemanticsService } from '../scripts/host/pdf-accessibility-table-semantics-service.mjs';
import { accessibilityLinksBookmarks } from '../scripts/host/professional-capability/accessibility-ops-extra.mjs';
import { makeButtonWidgetPdf } from './host-pdfkit-test-fixtures-b.js';
import { makeTablePdf, tableRequest } from './host-pdf-table-semantics-fixtures.mjs';
import { assert, addDocument, delivery, formRequest, initializedStore } from './support/professional-accessibility-route-client-cli-support.js';

test('professional accessibility CLI parses exact files, copies the verified artifact, and revokes it', async (t) => {
  const parsed = parseCliArguments([
    'professional-capability', 'input.pdf', '--capability-id', 'accessibility.form-semantics',
    '--request', 'request.json', '--output', 'output.pdf',
  ]);
  assert.equal(parsed.input, 'input.pdf');
  assert.equal(parsed.requestPath, 'request.json');
  assert.throws(() => parseCliArguments([
    'professional-capability', '--capability-id', 'accessibility.form-semantics', '--request', 'request.json', '--output', 'output.pdf',
  ]), { code: 'CLI_INVALID_ARGUMENTS' });
  assert.throws(() => parseCliArguments([
    'professional-capability', '--capability-id', 'forms.validate', '--request', 'request.json',
  ]), { code: 'CLI_DEDICATED_CAPABILITY_ENTRYPOINT' });

  const store = await initializedStore(t, 'cli');
  const sourcePdf = makeButtonWidgetPdf();
  const document = await addDocument(store, sourcePdf);
  const request = formRequest(sourcePdf);
  const professional = delivery(store, {
    accessibilityFormSemantics: new PdfAccessibilityFormSemanticsService({ store }),
  });
  const copied = [];
  const emitted = [];
  const deleted = [];
  const application = {
    professionalCapabilities: professional,
    store: {
      getArtifact: store.getArtifact.bind(store),
      async deleteArtifact(id) { deleted.push(id); return store.deleteArtifact(id); },
    },
  };
  const runtime = {
    cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); },
    uploadPdf: async (_application, input) => { assert.equal(input, 'input.pdf'); return document; },
    readLocalInputBytes: async (path, options) => {
      assert.equal(path, 'request.json');
      assert.equal(options.extension, '.json');
      return { bytes: Buffer.from(JSON.stringify(request)) };
    },
    copyExclusive: async (...args) => { copied.push(args); },
    emit: async (_stdout, value) => { emitted.push(value); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
  await runProfessionalCapabilityCommand(application, parsed, {}, undefined, runtime);
  assert.equal(copied.length, 1);
  assert.equal(copied[0][1], 'output.pdf');
  assert.equal(emitted[0].serviceReceipt.artifact.id, emitted[0].artifact.id);
  assert.equal(emitted[0].artifact.output, 'output.pdf');
  assert.deepEqual(deleted, [emitted[0].artifact.id]);
  assert.throws(() => store.getArtifact(deleted[0]), { code: 'ARTIFACT_NOT_FOUND' });
});

test('professional accessibility CLI completes the table and links/bookmarks operations with retained-artifact verification', async (t) => {
  const linksDemo = await accessibilityLinksBookmarks({
    demoFixture: true, links: [{ text: 'Details', purpose: 'Read details', page: 3 }], bookmarks: [{ title: 'Summary', page: 2 }],
  });
  const scenarios = [
    { capabilityId: 'accessibility.table-semantics', sourcePdf: makeTablePdf(), requestFor: tableRequest, services: (store) => ({ accessibilityTableSemantics: new PdfAccessibilityTableSemanticsService({ store }) }) },
    { capabilityId: 'accessibility.links-bookmarks', sourcePdf: Buffer.from(linksDemo.pdf.subarray(0, linksDemo.sourceByteLength)), requestFor: () => linksDemo.repairRequest, services: (store) => ({ accessibilityLinksBookmarks: new PdfAccessibilityLinksBookmarksService({ store }) }) },
  ];
  for (const scenario of scenarios) {
    const parsed = parseCliArguments([
      'professional-capability', 'input.pdf', '--capability-id', scenario.capabilityId, '--request', 'request.json', '--output', 'output.pdf',
    ]);
    const store = await initializedStore(t, `cli-${scenario.capabilityId}`);
    const document = await addDocument(store, scenario.sourcePdf);
    const request = scenario.requestFor(scenario.sourcePdf);
    const deleted = []; const copied = []; const emitted = [];
    const application = {
      professionalCapabilities: delivery(store, scenario.services(store)),
      store: { getArtifact: store.getArtifact.bind(store), async deleteArtifact(id) { deleted.push(id); return store.deleteArtifact(id); } },
    };
    await runProfessionalCapabilityCommand(application, parsed, {}, undefined, {
      cancelled() {}, uploadPdf: async () => document,
      readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(request)) }),
      copyExclusive: async (...args) => { copied.push(args); }, emit: async (_stdout, value) => { emitted.push(value); },
      fail(code, message) { throw Object.assign(new Error(message), { code }); },
    });
    assert.equal(copied.length, 1, scenario.capabilityId);
    assert.equal(emitted[0].capabilityId, scenario.capabilityId);
    assert.deepEqual(deleted, [emitted[0].artifact.id]);
    assert.throws(() => store.getArtifact(deleted[0]), { code: 'ARTIFACT_NOT_FOUND' });
  }
});

test('professional accessibility CLI cancels after copy and still revokes the retained artifact', async () => {
  const controller = new AbortController();
  const request = formRequest(makeButtonWidgetPdf());
  const artifactId = '22222222-2222-4222-8222-222222222222';
  const deleted = [];
  const application = {
    professionalCapabilities: {
      async deliverSourceBound() {
        return { artifact: { id: artifactId }, outputSha256: 'b'.repeat(64), pdf: Buffer.from('private') };
      },
    },
    store: {
      getArtifact: () => ({ id: artifactId, documentId: '11111111-1111-4111-8111-111111111111', sha256: 'b'.repeat(64), filePath: '/private/artifact.pdf' }),
      async deleteArtifact(id) { deleted.push(id); },
    },
  };
  const runtime = {
    cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }); },
    uploadPdf: async () => ({ id: '11111111-1111-4111-8111-111111111111', sha256: request.sourceSha256 }),
    readLocalInputBytes: async () => ({ bytes: Buffer.from(JSON.stringify(request)) }),
    copyExclusive: async () => { controller.abort(); },
    emit: async () => { throw new Error('must not emit'); },
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  };
  await assert.rejects(runProfessionalCapabilityCommand(application, {
    capabilityId: 'accessibility.form-semantics', input: 'input.pdf', requestPath: 'request.json', output: 'output.pdf',
  }, {}, controller.signal, runtime), { code: 'JOB_CANCELLED' });
  assert.deepEqual(deleted, [artifactId]);
});
