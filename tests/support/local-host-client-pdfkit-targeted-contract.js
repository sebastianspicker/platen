import test from 'node:test';
import { assert } from './local-host-client-fixture.js';
import {
  createPdfKitClientSession,
  expectPdfKitClientRequest,
  sourceSha256,
} from './local-host-client-pdfkit-fixture.js';

const targetedMutation = (formFill) => ({
  formFill, annotationUpdate: null, annotationRemove: null,
});

test('local host client strictly validates targeted text and annotation mutations', async () => {
  const session = await createPdfKitClientSession();
  const targeted = targetedMutation({
    page: 1, annotationIndex: 0, fingerprint: 'c'.repeat(64),
    fieldType: 'text', value: 'private',
  });
  await expectPdfKitClientRequest(
    session, 'runPdfKitTargetedMutation', 'macos-pdfkit-targeted-v1', targeted,
  );
  for (const invalid of [
    { formFill: null, annotationUpdate: null, annotationRemove: null },
    { ...targeted, formFill: { ...targeted.formFill, fingerprint: 'C'.repeat(64) } },
    {
      formFill: null,
      annotationUpdate: {
        page: 1, annotationIndex: 0, fingerprint: 'c'.repeat(64),
        subtype: 'freeText', contents: '', rect: { x: 0, y: 0, width: 10, height: 10 },
      },
      annotationRemove: null,
    },
    {
      formFill: null,
      annotationUpdate: {
        page: 1, annotationIndex: 0, fingerprint: 'c'.repeat(64),
        subtype: 'text', contents: 'x', rect: { x: 0, y: 0, width: 10, height: 10 },
      },
      annotationRemove: null,
    },
    {
      formFill: null, annotationUpdate: null,
      annotationRemove: {
        page: 1, annotationIndex: 50, fingerprint: 'c'.repeat(64), subtype: 'freeText',
      },
    },
  ]) assert.throws(() => session.client.runPdfKitTargetedMutation(
    'doc', sourceSha256, invalid,
  ), TypeError);
});

test('local host client distinguishes checkbox, choice, and radio form policy', async () => {
  const session = await createPdfKitClientSession();
  const checkbox = targetedMutation({
    page: 1, annotationIndex: 2, fingerprint: 'd'.repeat(64),
    fieldType: 'button', value: 'off',
  });
  await expectPdfKitClientRequest(
    session, 'runPdfKitTargetedMutation', 'macos-pdfkit-targeted-v1', checkbox,
  );
  for (const value of ['checked', '', true]) {
    assert.throws(() => session.client.runPdfKitTargetedMutation('doc', sourceSha256, {
      ...checkbox, formFill: { ...checkbox.formFill, value },
    }), TypeError);
  }

  const choice = targetedMutation({
    page: 1, annotationIndex: 1, fingerprint: 'e'.repeat(64),
    fieldType: 'choice', value: '',
  });
  await expectPdfKitClientRequest(
    session, 'runPdfKitTargetedMutation', 'macos-pdfkit-targeted-v1', choice,
  );
  assert.throws(() => session.client.runPdfKitTargetedMutation('doc', sourceSha256, {
    ...choice, formFill: { ...choice.formFill, value: null },
  }), TypeError);

  const radio = targetedMutation({
    page: 2, annotationIndex: 4, fingerprint: 'f'.repeat(64),
    fieldType: 'button', value: 'select',
  });
  await expectPdfKitClientRequest(
    session, 'runPdfKitTargetedMutation', 'macos-pdfkit-targeted-v1', radio,
  );
});
