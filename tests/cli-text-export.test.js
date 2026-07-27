import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';
import { makeTextPdf } from './pdf-fixture.js';

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function textApplication(source, pages, onExtract = null) {
  let disposed = false;
  return {
    application: {
      store: {
        async createDocument({ stream, displayName }) {
          for await (const _chunk of stream) { /* consume the private upload */ }
          return { id: 'document', displayName, size: source.length, sha256: 'a'.repeat(64) };
        },
        async dispose() { disposed = true; },
      },
      service: {
        async inspect(documentId) {
          assert.equal(documentId, 'document');
          return { pageCount: pages.length };
        },
        async extractText(documentId, pageCount) {
          assert.equal(documentId, 'document');
          assert.equal(pageCount, pages.length);
          onExtract?.();
          return pages;
        },
      },
    },
    disposed: () => disposed,
  };
}

test('CLI text exports bounded extracted pages as private escaped RTF', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-rtf-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const outputPath = join(directory, 'text.rtf');
  const source = makeTextPdf('RTF SOURCE');
  await writeFile(input, source);
  const fixture = textApplication(source, [
    { page: 1, text: 'A \\ {draft} café 😀' },
    { page: 2, text: 'Second' },
  ]);
  const output = capture();
  await runCli(['text', input, '--format', 'rtf', '--output', outputPath], {
    stdout: output.stream, createApplication: async () => fixture.application,
  });
  const rtf = await readFile(outputPath, 'utf8');
  assert.equal(output.text(), '');
  assert.match(rtf, /^\{\\rtf1\\ansi\\deff0\n/u);
  assert.match(rtf, /\\b Page 1\\b0/u);
  assert.match(rtf, /\\page\n\\b Page 2\\b0/u);
  assert.match(rtf, /\\\\ \\\{draft\\\} caf\\u233\? \\u-10179\?\\u-8704\?/u);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(input)).equals(source), true);
  assert.equal(fixture.disposed(), true);
});

test('CLI text cancellation after extraction publishes no output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-rtf-cancel-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.pdf');
  const outputPath = join(directory, 'cancelled.rtf');
  const source = makeTextPdf('RTF CANCELLATION');
  await writeFile(input, source);
  const controller = new AbortController();
  const fixture = textApplication(source, [{ page: 1, text: 'must not publish' }], () => controller.abort());
  await assert.rejects(
    runCli(['text', input, '--format', 'rtf', '--output', outputPath], {
      stdout: capture().stream,
      createApplication: async () => fixture.application,
      signal: controller.signal,
    }),
    { code: 'JOB_CANCELLED' },
  );
  await assert.rejects(access(outputPath), { code: 'ENOENT' });
  assert.equal(fixture.disposed(), true);
});

test('CLI text exports escaped page-separated HTML without layout claims', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-html-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'A & B.pdf');
  const outputPath = join(directory, 'text.html');
  const source = makeTextPdf('HTML SOURCE');
  await writeFile(input, source);
  const fixture = textApplication(source, [
    { page: 1, text: '<unsafe> & "quoted" \'apostrophe\'' },
    { page: 2, text: 'Second page' },
  ]);
  const output = capture();
  await runCli(['text', input, '--format', 'html', '--output', outputPath], {
    stdout: output.stream, createApplication: async () => fixture.application,
  });
  const html = await readFile(outputPath, 'utf8');
  assert.equal(output.text(), '');
  assert.match(html, /^<!doctype html>\n<html lang="en">/u);
  assert.match(html, /<title>A &amp; B\.pdf<\/title>/u);
  assert.match(html, /<section data-page="1"><h2>Page 1<\/h2>/u);
  assert.match(html, /&lt;unsafe&gt; &amp; &quot;quoted&quot; &apos;apostrophe&apos;/u);
  assert.match(html, /<section data-page="2"><h2>Page 2<\/h2>/u);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(input)).equals(source), true);
  assert.equal(fixture.disposed(), true);
});

test('CLI text exports well-formed XML 1.0 and rejects invalid text without publication', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-xml-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'A & B.pdf');
  const outputPath = join(directory, 'text.xml');
  const rejectedPath = join(directory, 'rejected.xml');
  const source = makeTextPdf('XML SOURCE');
  await writeFile(input, source);
  const fixture = textApplication(source, [
    { page: 1, text: '<unsafe> & "quoted" 😀' },
    { page: 2, text: 'Second page' },
  ]);
  const output = capture();
  await runCli(['text', input, '--format', 'xml', '--output', outputPath], {
    stdout: output.stream, createApplication: async () => fixture.application,
  });
  const xml = await readFile(outputPath, 'utf8');
  assert.equal(output.text(), '');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/u);
  assert.match(xml, /<document title="A &amp; B\.pdf">/u);
  assert.match(xml, /<page number="1">&lt;unsafe&gt; &amp; &quot;quoted&quot; 😀<\/page>/u);
  assert.match(xml, /<page number="2">Second page<\/page>/u);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(input)).equals(source), true);
  assert.equal(fixture.disposed(), true);

  const invalid = textApplication(source, [{ page: 1, text: 'invalid\u000btext' }]);
  await assert.rejects(
    runCli(['text', input, '--format', 'xml', '--output', rejectedPath], {
      stdout: capture().stream, createApplication: async () => invalid.application,
    }),
    /forbidden by XML 1\.0/u,
  );
  await assert.rejects(access(rejectedPath), { code: 'ENOENT' });
  assert.equal(invalid.disposed(), true);
});
