import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { AutomationPreflightServerQueue } from '../../src/host/application/automation/automation-preflight-server-queue.mjs';
import { RedactionDomainService } from '../../src/host/application/domains/redaction-domain.mjs';
import { OcrDocumentPipeline } from '../../src/host/application/ocr/ocr-document-pipeline.mjs';
import { validateCopyPageRequest } from '../../src/host/application/pdf/pdf-copy-page-admission.mjs';
import { buildPreflightReport, serializePreflightReportXml } from '../../src/host/application/prepress/preflight-rules.mjs';
import { parsePluginPackage } from '../../src/host/application/plugins/plugin-package-codec.mjs';
import { ReviewFormsWorkspace } from '../../src/host/application/domains/review-forms-workspace.mjs';
import { TrustedPublisherStore } from '../../src/host/application/security/trusted-publisher-store.mjs';

const digest = 'a'.repeat(64);

test('PDF source binding and OCR admission reject stale input or unavailable engines before work begins', async () => {
  const primary = { sha256: digest, pageCount: 2 };
  const secondary = { sha256: 'b'.repeat(64), pageCount: 3 };
  assert.deepEqual(validateCopyPageRequest({
    profile: 'local-copy-one-page-between-documents-v1',
    primarySourceSha256: digest, secondarySourceSha256: secondary.sha256, sourcePage: 1, afterPage: 0,
  }, primary, secondary).afterPage, 0);
  assert.throws(() => validateCopyPageRequest({
    profile: 'local-copy-one-page-between-documents-v1',
    primarySourceSha256: 'c'.repeat(64), secondarySourceSha256: secondary.sha256, sourcePage: 1, afterPage: 0,
  }, primary, secondary), { code: 'SOURCE_VERSION_MISMATCH' });
  await assert.rejects(new OcrDocumentPipeline({}).run('document-id'), { code: 'ENGINE_UNAVAILABLE' });
});

test('review and domain services preserve revision checks and leave redaction bytes untouched', () => {
  let snapshot = { revision: 3, entities: {} };
  const workspaceState = {
    snapshot: () => structuredClone(snapshot),
    replaceSnapshot: (_documentId, next, { expectedRevision }) => {
      assert.equal(expectedRevision, snapshot.revision);
      snapshot = { ...next, revision: snapshot.revision + 1 };
      return structuredClone(snapshot);
    },
  };
  const review = new ReviewFormsWorkspace(workspaceState);
  assert.throws(() => review.mutate('document', 2, () => {}), { code: 'REVISION_CONFLICT' });
  assert.equal(review.mutate('document', 3, (value) => { value.entities.reviewed = true; }).revision, 4);

  const created = [];
  const domain = new RedactionDomainService({
    snapshot: () => ({ revision: 4 }),
    createEntity: (documentId, kind, record, options) => { created.push({ documentId, kind, record, options }); return record; },
  }, { clock: () => '2026-08-30T00:00:00.000Z', idFactory: () => 'plan-1' });
  const plan = domain.createRedactionPlan('document', { pages: [{ pageNumber: 1, text: 'email me@example.com' }] }, { expectedRevision: 4 });
  assert.equal(plan.status, 'proposed-not-applied');
  assert.equal(plan.report.byteRemovalClaim, false);
  assert.equal(created[0].kind, 'redactions');
  assert.deepEqual(domain.applyRedactions('document', plan.id), {
    status: 'not-applied', code: 'RASTER_SEMANTIC_VERIFIER_REQUIRED', bytesRemoved: false,
    message: 'No PDF bytes were changed; a separate raster and semantic verifier is required.',
  });
});

test('plugin trust and package parsing require bounded canonical local administration inputs', () => {
  assert.throws(() => parsePluginPackage('{"z":1,"a":2}'), { code: 'PACKAGE_NONCANONICAL' });
  const { publicKey } = generateKeyPairSync('ed25519');
  const store = new TrustedPublisherStore();
  const enrolled = store.enroll({
    publisherId: 'org.platen.fixture', keyId: 'fixture-key',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }), pluginIds: ['org.platen.fixture'],
  });
  store.revoke({ publisherId: enrolled.publisherId, keyId: enrolled.keyId });
  assert.equal(store.get(enrolled.publisherId, enrolled.keyId).revoked, true);
});

test('automation queue cancels queued work while prepress reports stay deterministic and non-certifying', async () => {
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const queue = new AutomationPreflightServerQueue({ concurrency: 1, maximumQueued: 2 });
  const first = queue.enqueue('first', new AbortController(), async () => { await gate; return 'done'; });
  const secondController = new AbortController();
  const second = queue.enqueue('second', secondController, async () => 'must-not-run');
  assert.equal(queue.cancel('second'), true);
  await assert.rejects(second, { code: 'AUTOMATION_PREFLIGHT_SERVER_CANCELLED' });
  release();
  assert.equal(await first, 'done');
  await queue.close();

  const report = buildPreflightReport({
    profile: 'print-review', document: { sha256: digest }, inspection: { pageCount: 1, encrypted: 'no', javascript: 'no' },
    structure: { sourceDigest: digest, pageRange: { truncated: false }, pageBoxes: [{ widthPoints: 612, heightPoints: 792, boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792 }, bleedBox: { left: 0, bottom: 0, right: 612, top: 792 }, trimBox: { left: 0, bottom: 0, right: 612, top: 792 } } }] },
    fonts: [], images: [],
  });
  assert.equal(report.localOnly, true);
  assert.equal(report.authoritative, false);
  assert.equal(report.status, 'review-required');
  assert.match(serializePreflightReportXml(report), /authoritative="false"/u);
});
