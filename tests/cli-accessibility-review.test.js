import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';
import { AccessibilityReviewService } from '../scripts/host/accessibility-review-service.mjs';
import { sha256 } from '../scripts/host/accessibility-review-utils.mjs';
import { makeTextPdf } from './pdf-fixture.js';

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function reviewApplication(source, report, onReview = null) {
  let disposed = false;
  return {
    application: {
      store: {
        async createDocument({ stream, displayName }) {
          for await (const _chunk of stream) { /* consume the private upload */ }
          return { id: 'document', displayName, size: source.length, sha256: report.sourceDigest };
        },
        async dispose() { disposed = true; },
      },
      accessibilityReviews: {
        async review(documentId, options) {
          assert.equal(documentId, 'document');
          assert.equal(options.signal instanceof AbortSignal || options.signal === undefined, true);
          onReview?.();
          return report;
        },
      },
    },
    disposed: () => disposed,
  };
}

async function reportFixture() {
  const sourceDigest = 'a'.repeat(64);
  const service = new AccessibilityReviewService({
    store: {
      getDocument: () => ({ id: 'document', sha256: sourceDigest }),
      verifySource: async () => true,
    },
    pdfService: {
      inspect: async () => ({ pageCount: 1, tagged: 'yes', title: 'Fixture', form: 'none' }),
      inspectStructure: async () => ({
        sourceDigest,
        pageRange: { firstPage: 1, lastPage: 1 },
        taggedStructure: {
          present: true, includesText: false,
          lines: [{ depth: 0, value: 'Document' }, { depth: 2, value: 'P (block)' }],
        },
        xmpMetadata: { xml: '<dc:language><rdf:Bag><rdf:li>en</rdf:li></rdf:Bag></dc:language>' },
        customMetadata: [],
        urls: [],
      }),
      listFonts: async () => [{ unicode: 'yes', embedded: 'yes' }],
      listImages: async () => [],
      extractText: async () => [{ page: 1, text: 'used only inside the review service' }],
    },
  });
  return service.review('document');
}

test('CLI exports the fixed local accessibility review as private JSON', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-accessibility-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const outputPath = join(directory, 'review.json');
  const source = makeTextPdf('ACCESSIBILITY REVIEW');
  const report = await reportFixture();
  await writeFile(input, source);
  const fixture = reviewApplication(source, report);
  const output = capture();
  await runCli(['accessibility-review', input, '--output', outputPath], {
    stdout: output.stream, createApplication: async () => fixture.application,
  });
  const bytes = await readFile(outputPath, 'utf8');
  assert.equal(bytes, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(output.text(), '');
  assert.equal(JSON.parse(bytes).sourceDigest, report.sourceDigest);
  assert.equal(JSON.parse(bytes).reportSha256, report.reportSha256);
  assert.doesNotMatch(bytes, /extracted page text|\/private\//iu);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(input)).equals(source), true);
  assert.equal(fixture.disposed(), true);
});

test('CLI accessibility-review cancellation publishes no report', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-accessibility-cancel-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const outputPath = join(directory, 'cancelled.json');
  const source = makeTextPdf('ACCESSIBILITY CANCELLATION');
  await writeFile(input, source);
  const controller = new AbortController();
  const fixture = reviewApplication(source, await reportFixture(), () => controller.abort());
  await assert.rejects(
    runCli(['accessibility-review', input, '--output', outputPath], {
      stdout: capture().stream,
      createApplication: async () => fixture.application,
      signal: controller.signal,
    }),
    { code: 'JOB_CANCELLED' },
  );
  await assert.rejects(access(outputPath), { code: 'ENOENT' });
  assert.equal(fixture.disposed(), true);
});

test('CLI rejects malformed or source-unbound accessibility reports without residue', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-accessibility-invalid-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const outputPath = join(directory, 'invalid.json');
  const source = makeTextPdf('ACCESSIBILITY INVALID REPORT');
  await writeFile(input, source);
  const valid = await reportFixture();
  const malformed = {
    ...valid,
    sourceDigest: 'c'.repeat(64),
    authoritative: true,
    privatePath: '/private/tmp/secret.pdf',
    extractedPageText: 'SECRET',
  };
  const fixture = reviewApplication(source, malformed);
  await assert.rejects(
    runCli(['accessibility-review', input, '--output', outputPath], {
      stdout: capture().stream,
      createApplication: async () => fixture.application,
    }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
  await assert.rejects(access(outputPath), { code: 'ENOENT' });
  assert.equal(fixture.disposed(), true);
});

test('CLI rejects re-signed disclosure text in accessibility remediation without residue', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-accessibility-disclosure-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const outputPath = join(directory, 'disclosure.json');
  const source = makeTextPdf('ACCESSIBILITY DISCLOSURE GUARD');
  await writeFile(input, source);
  const valid = structuredClone(await reportFixture());
  valid.remediationPlan.candidates[0].reason = 'Raw extracted page text: SECRET; source /private/tmp/input.pdf';
  const { reportSha256: _reportSha256, ...unsigned } = valid;
  const malicious = { ...unsigned, reportSha256: sha256(unsigned) };
  const fixture = reviewApplication(source, malicious);
  await assert.rejects(
    runCli(['accessibility-review', input, '--output', outputPath], {
      stdout: capture().stream,
      createApplication: async () => fixture.application,
    }),
    { code: 'ACCESSIBILITY_REVIEW_INVALID', status: 502 },
  );
  await assert.rejects(access(outputPath), { code: 'ENOENT' });
  assert.equal(fixture.disposed(), true);
});
