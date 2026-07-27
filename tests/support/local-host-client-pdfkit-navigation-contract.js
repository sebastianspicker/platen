import test from 'node:test';
import { assert } from './local-host-client-fixture.js';
import {
  createPdfKitClientSession,
  expectPdfKitClientRequest,
  sourceSha256,
} from './local-host-client-pdfkit-fixture.js';

test('local host client bounds outline bookmark creation', async () => {
  const session = await createPdfKitClientSession();
  const mutation = { bookmark: { page: 2, label: 'Appendix' } };
  await expectPdfKitClientRequest(
    session, 'runPdfKitOutlineMutation', 'macos-pdfkit-outline-v1', mutation,
  );
  for (const invalid of [
    { ...mutation, action: 'GoTo' },
    { bookmark: { ...mutation.bookmark, page: 101 } },
    { bookmark: { ...mutation.bookmark, label: '' } },
    { bookmark: { ...mutation.bookmark, label: ' edge' } },
    { bookmark: { ...mutation.bookmark, label: 'unsafe\u202E' } },
    { bookmark: { ...mutation.bookmark, label: 'e\u0301' } },
  ]) assert.throws(() => session.client.runPdfKitOutlineMutation(
    'doc', sourceSha256, invalid,
  ), TypeError);
  assert.throws(() => session.client.runPdfKitOutlineMutation(
    'doc', 'B'.repeat(64), mutation,
  ), TypeError);
});

test('local host client bounds outline bookmark removal', async () => {
  const session = await createPdfKitClientSession();
  const mutation = {
    bookmarkRemoval: { topLevelIndex: 0, fingerprint: 'e'.repeat(64) },
  };
  await expectPdfKitClientRequest(
    session, 'runPdfKitOutlineRemovalMutation', 'macos-pdfkit-outline-remove-v1', mutation,
  );
  for (const invalid of [
    { ...mutation, label: 'spoof' },
    { bookmarkRemoval: { ...mutation.bookmarkRemoval, topLevelIndex: -1 } },
    { bookmarkRemoval: { ...mutation.bookmarkRemoval, topLevelIndex: 200 } },
    { bookmarkRemoval: { ...mutation.bookmarkRemoval, fingerprint: 'E'.repeat(64) } },
  ]) assert.throws(() => session.client.runPdfKitOutlineRemovalMutation(
    'doc', sourceSha256, invalid,
  ), TypeError);
});

test('local host client bounds outline bookmark rename', async () => {
  const session = await createPdfKitClientSession();
  const mutation = {
    bookmarkRename: {
      topLevelIndex: 0, fingerprint: 'e'.repeat(64), label: 'Renamed bookmark',
    },
  };
  await expectPdfKitClientRequest(
    session, 'runPdfKitOutlineRenameMutation', 'macos-pdfkit-outline-rename-v1', mutation,
  );
  for (const invalid of [
    { ...mutation, unexpected: true },
    { bookmarkRename: { ...mutation.bookmarkRename, topLevelIndex: 200 } },
    { bookmarkRename: { ...mutation.bookmarkRename, fingerprint: 'E'.repeat(64) } },
    { bookmarkRename: { ...mutation.bookmarkRename, label: 'e\u0301' } },
  ]) assert.throws(() => session.client.runPdfKitOutlineRenameMutation(
    'doc', sourceSha256, invalid,
  ), TypeError);
});

test('local host client bounds exact local GoTo removal identity', async () => {
  const session = await createPdfKitClientSession();
  const mutation = {
    linkRemoval: { page: 1, annotationIndex: 0, fingerprint: 'f'.repeat(64) },
  };
  await expectPdfKitClientRequest(
    session, 'runPdfKitLocalGoToRemovalMutation',
    'macos-pdfkit-local-goto-remove-v1', mutation,
  );
  for (const invalid of [
    { ...mutation, targetPage: 2 },
    { linkRemoval: { ...mutation.linkRemoval, page: 101 } },
    { linkRemoval: { ...mutation.linkRemoval, annotationIndex: 50 } },
    { linkRemoval: { ...mutation.linkRemoval, fingerprint: 'F'.repeat(64) } },
  ]) assert.throws(() => session.client.runPdfKitLocalGoToRemovalMutation(
    'doc', sourceSha256, invalid,
  ), TypeError);
  assert.throws(() => session.client.runPdfKitLocalGoToRemovalMutation(
    'doc', 'B'.repeat(64), mutation,
  ), TypeError);
});
