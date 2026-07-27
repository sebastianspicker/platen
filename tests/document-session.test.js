import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import test from 'node:test';
import { DocumentSession, isPdfCandidate, MAX_LOCAL_PDF_BYTES } from '../src/core/document-session.js';

function fixture(name = 'first.pdf', overrides = {}) {
  const { type = 'application/pdf', contents = '%PDF-1.7\nfixture', size, ...fileOptions } = overrides;
  const body = size === undefined ? contents : new Uint8Array(size);
  return new File([body], name, { type, ...fileOptions });
}

function urlFixture() {
  const revoked = [];
  let sequence = 0;
  return {
    api: {
      createObjectURL: () => `blob:test-${++sequence}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
    revoked,
  };
}

test('PDF candidate detection accepts MIME or extension and rejects other files', () => {
  assert.equal(isPdfCandidate(fixture()), true);
  assert.equal(isPdfCandidate(fixture('scan.PDF', { type: '' })), true);
  assert.equal(isPdfCandidate(fixture('notes.txt', { type: 'text/plain' })), false);
});

test('opening a replacement and closing revoke every prior object URL', async () => {
  const urls = urlFixture();
  const session = new DocumentSession({ urlApi: urls.api });
  await session.open(fixture('first.pdf'));
  assert.equal(session.snapshot.objectUrl, 'blob:test-1');
  await session.open(fixture('second.pdf'));
  assert.deepEqual(urls.revoked, ['blob:test-1']);
  session.close();
  assert.deepEqual(urls.revoked, ['blob:test-1', 'blob:test-2']);
  assert.equal(session.snapshot.isOpen, false);
});

test('download access returns the exact source object and exposes no overwrite API', async () => {
  const urls = urlFixture();
  const source = fixture();
  const session = new DocumentSession({ urlApi: urls.api });
  await session.open(source);
  assert.equal(session.getOriginal(), source);
  assert.equal(session.snapshot.modified, false);
  assert.equal('overwrite' in session, false);
  assert.equal('save' in session, false);
});

test('invalid and empty files fail without replacing the current session', async () => {
  const urls = urlFixture();
  const session = new DocumentSession({ urlApi: urls.api });
  await session.open(fixture());
  await assert.rejects(() => session.open(fixture('bad.txt', { type: 'text/plain' })), { code: 'NOT_A_PDF' });
  await assert.rejects(() => session.open(fixture('empty.pdf', { size: 0 })), { code: 'EMPTY_FILE' });
  assert.equal(session.snapshot.objectUrl, 'blob:test-1');
  assert.deepEqual(urls.revoked, []);
});

test('renamed content, contradictory MIME, and oversized input fail closed', async () => {
  const session = new DocumentSession({ urlApi: urlFixture().api });
  await assert.rejects(() => session.open(fixture('renamed.pdf', { contents: '<html>not pdf</html>' })), { code: 'INVALID_PDF_HEADER' });
  await assert.rejects(() => session.open(fixture('contradictory.pdf', { type: 'text/html' })), { code: 'NOT_A_PDF' });
  const oversized = { name: 'huge.pdf', type: 'application/pdf', size: MAX_LOCAL_PDF_BYTES + 1, slice: () => new Blob(['%PDF-1.7']) };
  await assert.rejects(() => session.open(oversized), { code: 'FILE_TOO_LARGE' });
});

test('PDF header may appear within the first 1,024 bytes', async () => {
  const session = new DocumentSession({ urlApi: urlFixture().api });
  const file = fixture('offset.pdf', { contents: `${'x'.repeat(80)}%PDF-1.7\nfixture` });
  await session.open(file);
  assert.equal(session.snapshot.isOpen, true);
});

test('a superseded asynchronous open cannot replace the active session', async () => {
  const urls = urlFixture();
  const session = new DocumentSession({ urlApi: urls.api });
  await session.open(fixture('current.pdf'));
  await assert.rejects(
    session.open(fixture('stale.pdf'), { shouldCommit: () => false }),
    { code: 'OPEN_SUPERSEDED' },
  );
  assert.equal(session.snapshot.name, 'current.pdf');
  assert.equal(session.snapshot.objectUrl, 'blob:test-1');
  assert.deepEqual(urls.revoked, []);
});
