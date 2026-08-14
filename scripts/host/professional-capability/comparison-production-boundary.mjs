import { canonicalComparisonJson, contentReceiptBytes } from '../comparison-package-contract.mjs';
import { validateContentComparisonReceipt } from '../comparison-report.mjs';
import { fail, result, sha256 } from './support.mjs';
import { spreadsheetSafeCsvCell } from '../../../src/core/spreadsheet-safe-csv.js';

const DIGEST = /^[0-9a-f]{64}$/u;

export async function authoritativeStorePair(ctx) {
  const store = ctx.store;
  if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function') {
    fail('COMPARISON_SERVICE_UNAVAILABLE', 'Professional comparison requires a source-bound local document store.', 503);
  }
  const primaryId = ctx.primaryDocumentId;
  const revisionId = ctx.revisionDocumentId;
  if (typeof primaryId !== 'string' || !primaryId || typeof revisionId !== 'string' || !revisionId || primaryId === revisionId) {
    fail('COMPARISON_SOURCE_REQUIRED', 'Professional comparison requires two distinct local PDF document identifiers.');
  }
  if (!DIGEST.test(ctx.primarySha256 ?? '') || !DIGEST.test(ctx.revisionSha256 ?? '')) {
    fail('COMPARISON_SOURCE_REQUIRED', 'Professional comparison requires authoritative primarySha256 and revisionSha256 digests.');
  }
  let primary;
  let revision;
  try {
    primary = store.getDocument(primaryId);
    revision = store.getDocument(revisionId);
  } catch {
    fail('COMPARISON_SOURCE_REQUIRED', 'Professional comparison sources are not available in the local store.');
  }
  if (!primary || !revision || primary.id !== primaryId || revision.id !== revisionId
    || primary.mediaType !== 'application/pdf' || revision.mediaType !== 'application/pdf'
    || primary.sha256 !== ctx.primarySha256 || revision.sha256 !== ctx.revisionSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'Comparison source digests do not match the current local documents.', 409);
  }
  try {
    const verified = await Promise.all([store.verifySource(primaryId), store.verifySource(revisionId)]);
    if (verified.some((value) => value !== true)) throw new Error('source verification returned false');
  } catch {
    fail('COMPARISON_SOURCE_INTEGRITY_FAILED', 'Comparison source integrity could not be verified.', 502);
  }
  const rereadPrimary = store.getDocument(primaryId);
  const rereadRevision = store.getDocument(revisionId);
  if (!rereadPrimary || !rereadRevision
    || rereadPrimary.sha256 !== primary.sha256 || rereadRevision.sha256 !== revision.sha256
    || rereadPrimary.size !== primary.size || rereadRevision.size !== revision.size
    || rereadPrimary.mediaType !== primary.mediaType || rereadRevision.mediaType !== revision.mediaType) {
    fail('SOURCE_VERSION_MISMATCH', 'Comparison sources changed during processing.', 409);
  }
  return Object.freeze({ store, primary, revision });
}

export function productionService(ctx, method) {
  const service = ctx.comparisonService ?? ctx.service;
  if (!service || typeof service[method] !== 'function') {
    fail('COMPARISON_SERVICE_UNAVAILABLE', `Professional comparison requires the local ${method} service.`, 503);
  }
  return service;
}

export async function productionContent(ctx) {
  const binding = await authoritativeStorePair(ctx);
  const service = productionService(ctx, 'compareContent');
  let report;
  try {
    report = await service.compareContent(binding.primary.id, binding.revision.id, { signal: ctx.signal });
  } catch (error) {
    if (error?.code) throw error;
    fail('COMPARISON_SERVICE_FAILED', 'The local comparison service failed.', 502);
  }
  const stable = validateContentComparisonReceipt(report);
  if (stable.inputs[0].sha256 !== binding.primary.sha256
    || stable.inputs[1].sha256 !== binding.revision.sha256) {
    fail('COMPARISON_RECEIPT_INVALID', 'The local comparison report is not bound to the requested source digests.', 502);
  }
  try {
    const verified = await Promise.all([
      binding.store.verifySource(binding.primary.id),
      binding.store.verifySource(binding.revision.id),
    ]);
    if (verified.some((value) => value !== true)) throw new Error('source verification returned false');
    const rereadPrimary = binding.store.getDocument(binding.primary.id);
    const rereadRevision = binding.store.getDocument(binding.revision.id);
    if (rereadPrimary?.sha256 !== binding.primary.sha256
      || rereadRevision?.sha256 !== binding.revision.sha256
      || rereadPrimary?.size !== binding.primary.size
      || rereadRevision?.size !== binding.revision.size) {
      throw new Error('source metadata changed');
    }
  } catch {
    fail('COMPARISON_SOURCE_INTEGRITY_FAILED', 'Comparison sources changed during processing.', 502);
  }
  const json = canonicalComparisonJson(stable);
  return Object.freeze({ binding, service, issuedReport: report, report: stable, json, reportSha256: sha256(Buffer.from(json, 'utf8')) });
}

export function directResult(capabilityId, pair, payload) {
  return result(capabilityId, {
    ...payload,
    demoFixtureUsed: pair.demoFixtureUsed,
    professionalProof: false,
    limitations: Object.freeze([
      ...(payload.limitations ?? []),
      'This direct-byte comparison is bounded local evidence, not a retained-store professional proof.',
    ]),
  });
}

export function sourceBinding(pair) {
  return Object.freeze({ primary: pair.primary.sha256, revision: pair.revision.sha256 });
}

export function comparisonCsv(report) {
  const [primary, revision] = report.inputs;
  const rows = [
    'primarySha256,secondarySha256,kind,page,status,added,deleted,unchanged,changedPixels,comparedPixels',
    ...report.pages.map((page) => [
      primary.sha256, revision.sha256, report.kind, page.page,
      page.status ?? '', page.stats?.added ?? '', page.stats?.deleted ?? '',
      page.stats?.unchanged ?? '', page.changedPixels ?? '', page.comparedPixels ?? '',
    ]),
  ];
  return `${rows.map((row) => Array.isArray(row)
    ? row.map((value) => spreadsheetSafeCsvCell(value)).join(',')
    : row).join('\n')}\n`;
}

export { contentReceiptBytes };
