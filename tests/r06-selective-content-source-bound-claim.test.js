import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { before, test } from 'node:test';
import {
  canRunIntegration,
  deriveTargetedSanitizationSource,
  makeMultiPagePdf,
  parseClassicPdfAnnotationPages,
  runInspection,
  runTargetedMutation,
  sourceSha256,
  targetedMutationRequest,
  packagePath,
} from './host-pdfkit-test-support.js';
import { fixture, documentId, sourceDigest } from './support/pdfkit-mutation-service-fixtures.js';

const PROFILE = 'macos-pdfkit-targeted-v1';
const target = (fingerprint = '7'.repeat(64)) => ({
  page: 1, annotationIndex: 0, fingerprint, subtype: 'freeText',
});
const removal = (locator = target()) => ({
  formFill: null, annotationUpdate: null, annotationRemove: locator, annotationProperties: null,
});

before({ skip: !canRunIntegration() }, () => {
  const build = spawnSync('swift', ['build', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

test('R06 selective annotation removal is source-bound, preserves decoys, and proves reachable readback', { skip: !canRunIntegration() }, async (context) => {
  const workspace = await mkdtemp('/tmp/platen-r06-selective-');
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'input.pdf'), makeMultiPagePdf(['targeted annotation source', 'non-target annotation source']), { mode: 0o600 });
  await chmod(workspace, 0o700);
  let source;
  try {
    source = await deriveTargetedSanitizationSource(workspace);
  } catch (error) {
    context.skip(`installed PDFKit helper fixture unavailable: ${error.message}`);
    return;
  }
  const sourceBefore = await readFile(join(workspace, 'input.pdf'));
  const before = await runInspection(workspace);
  const targetAnnotation = before.response.result.pages[0].annotations.find((item) => item.subtype === 'freeText');
  assert.equal(targetAnnotation.annotationIndex, 0);
  const rawBefore = parseClassicPdfAnnotationPages(source);
  assert.deepEqual(rawBefore.map((page) => page.map(({ subtype }) => subtype)), [['FreeText', 'Circle'], ['Square']]);

  const result = await runTargetedMutation(workspace, targetedMutationRequest(
    sourceSha256(source), removal({
      page: 1,
      annotationIndex: targetAnnotation.annotationIndex,
      fingerprint: targetAnnotation.fingerprint,
      subtype: 'freeText',
    }),
  ));
  assert.equal(result.response.ok, true, result.raw);
  assert.equal(result.response.result.appliedEdits, 1);
  assert.equal(Object.hasOwn(result.response.result, 'inspection'), false);
  const outputInspection = (await runInspection(workspace, 'output.pdf')).response.result;
  assert.deepEqual(outputInspection.pages.map(({ annotations }) => annotations.map(({ subtype }) => subtype)), [['circle'], ['square']]);
  const rawAfter = parseClassicPdfAnnotationPages(await readFile(join(workspace, 'output.pdf')));
  assert.deepEqual(rawAfter, rawBefore.map((page, index) => (index === 0 ? page.toSpliced(0, 1) : page)));
  assert.deepEqual(await readFile(join(workspace, 'input.pdf')), sourceBefore);
  assert.notDeepEqual(await readFile(join(workspace, 'output.pdf')), sourceBefore);
  assert.doesNotMatch(result.raw, /private targeted removal contents|private retained target-page contents|private non-target-page contents/u);
  assert.doesNotMatch(result.raw, new RegExp(targetAnnotation.fingerprint, 'u'));
});

test('R06 service path retains selective-removal evidence without locator or content leakage', async (context) => {
  const setup = await fixture(); context.after(setup.dispose);
  const result = await setup.service.mutate(documentId, removal({ page: 1, annotationIndex: 3, fingerprint: '7'.repeat(64), subtype: 'freeText' }), { sourceSha256: sourceDigest, profile: PROFILE });
  assert.equal(result.kind, 'pdfkit-selective-sanitization');
  assert.equal(result.artifact.documentId, documentId);
  assert.notEqual(result.artifact.id, documentId);
  assert.equal(result.evidence.sourceUnchanged, true);
  assert.equal(result.evidence.reachableAnnotationRemovalVerified, true);
  assert.equal(result.artifact.operation.validation.validators.includes('raw-reachable-annotation-delta'), true);
  assert.doesNotMatch(JSON.stringify(result), /7777777777777777|fingerprint|contents/u);
  assert.doesNotMatch(JSON.stringify(result.artifact.operation), /7777777777777777|fingerprint|contents/u);
});

test('R06 source-bound selective removal rejects stale, hostile, and signed inputs', async (context) => {
  const stale = await fixture(); context.after(stale.dispose);
  await assert.rejects(stale.service.mutate(documentId, removal(), { sourceSha256: '0'.repeat(64), profile: PROFILE }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  const hostile = await fixture(); context.after(hostile.dispose);
  await assert.rejects(hostile.service.mutate(documentId, { ...removal(), unexpected: true }, { sourceSha256: sourceDigest, profile: PROFILE }), { code: 'INVALID_PDFKIT_MUTATION', status: 400 });
  const signed = await fixture({ signatureOutput: 'Signature #1:\n  - Signature Type: adbe.pkcs7.detached\n  - Total document signed\n' }); context.after(signed.dispose);
  await assert.rejects(signed.service.mutate(documentId, removal(), { sourceSha256: sourceDigest, profile: PROFILE }), { code: 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED', status: 422 });
});

test('R06 cancellation and forged response clean the private output workspace', async (context) => {
  const cancelled = await fixture(); context.after(cancelled.dispose);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.service.mutate(documentId, removal(), { sourceSha256: sourceDigest, profile: PROFILE, signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(cancelled.state().observed, null);
  const forged = await fixture({ targetedReceiptOverride: { sourceSha256: 'f'.repeat(64) } }); context.after(forged.dispose);
  await assert.rejects(forged.service.mutate(documentId, removal(), { sourceSha256: sourceDigest, profile: PROFILE }), { code: 'PDFKIT_POSTFLIGHT_INVALID', status: 502 });
  assert.equal(forged.state().cleaned, true);
});
