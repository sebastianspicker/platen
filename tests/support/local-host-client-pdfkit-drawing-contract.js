import test from 'node:test';
import { assert } from './local-host-client-fixture.js';
import {
  createPdfKitClientSession,
  expectPdfKitClientRequest,
  sourceSha256,
} from './local-host-client-pdfkit-fixture.js';

test('local host client bounds local GoTo link creation', async () => {
  const session = await createPdfKitClientSession();
  const mutation = {
    link: { sourcePage: 1, targetPage: 2, rect: { x: 20, y: 320, width: 120, height: 30 } },
  };
  await expectPdfKitClientRequest(
    session, 'runPdfKitLocalGoToMutation', 'macos-pdfkit-local-goto-v1', mutation,
  );
  for (const invalid of [
    { ...mutation, path: '/tmp/evil' },
    { link: { ...mutation.link, uri: 'https://example.invalid' } },
    { link: { ...mutation.link, targetPage: 101 } },
    { link: { ...mutation.link, rect: { ...mutation.link.rect, height: 0 } } },
  ]) assert.throws(() => session.client.runPdfKitLocalGoToMutation(
    'doc', sourceSha256, invalid,
  ), TypeError);
  assert.throws(() => session.client.runPdfKitLocalGoToMutation(
    'doc', 'B'.repeat(64), mutation,
  ), TypeError);
});

test('local host client bounds line annotation creation', async () => {
  const session = await createPdfKitClientSession();
  const mutation = {
    line: {
      page: 1, contents: 'private line',
      start: { x: 20, y: 30 }, end: { x: 160, y: 210 },
    },
  };
  await expectPdfKitClientRequest(
    session, 'runPdfKitLineAnnotationMutation', 'macos-pdfkit-line-annotation-v1', mutation,
  );
  for (const invalid of [
    { ...mutation, path: '/tmp/evil' },
    { line: { ...mutation.line, action: 'launch' } },
    { line: { ...mutation.line, page: 101 } },
    { line: { ...mutation.line, contents: '' } },
    { line: { ...mutation.line, end: { ...mutation.line.start } } },
    { line: { ...mutation.line, start: { x: Number.POSITIVE_INFINITY, y: 30 } } },
  ]) assert.throws(() => session.client.runPdfKitLineAnnotationMutation(
    'doc', sourceSha256, invalid,
  ), TypeError);
  assert.throws(() => session.client.runPdfKitLineAnnotationMutation(
    'doc', 'B'.repeat(64), mutation,
  ), TypeError);
});

test('local host client bounds ink annotation creation', async () => {
  const session = await createPdfKitClientSession();
  const mutation = {
    ink: {
      page: 1, contents: 'private ink',
      points: [{ x: 20, y: 30 }, { x: 90, y: 100 }, { x: 160, y: 210 }],
    },
  };
  await expectPdfKitClientRequest(
    session, 'runPdfKitInkAnnotationMutation', 'macos-pdfkit-ink-annotation-v1', mutation,
  );
  for (const invalid of [
    { ...mutation, path: '/tmp/evil' },
    { ink: { ...mutation.ink, action: 'launch' } },
    { ink: { ...mutation.ink, page: 101 } },
    { ink: { ...mutation.ink, contents: '' } },
    { ink: { ...mutation.ink, points: [{ x: 1, y: 1 }] } },
    { ink: { ...mutation.ink, points: Array.from({ length: 33 }, (_, index) => ({ x: index, y: index })) } },
    { ink: { ...mutation.ink, points: [{ x: 1, y: 1 }, { x: 1, y: 1 }] } },
    { ink: { ...mutation.ink, points: [{ x: Number.POSITIVE_INFINITY, y: 30 }, { x: 2, y: 2 }] } },
  ]) assert.throws(() => session.client.runPdfKitInkAnnotationMutation(
    'doc', sourceSha256, invalid,
  ), TypeError);
  assert.throws(() => session.client.runPdfKitInkAnnotationMutation(
    'doc', 'B'.repeat(64), mutation,
  ), TypeError);
});
