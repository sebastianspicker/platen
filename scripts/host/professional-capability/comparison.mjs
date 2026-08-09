import { fail, requireBytes, requireString, result, sha256 } from './support.mjs';
import { diffTokens } from '../comparison-algorithms.mjs';
import { createTextPdf } from '../pdf-factory.mjs';
import { parseClassicPdfStructure, parsePdfStructure } from '../pdf-classic-structure.mjs';
import { resolvePdfPageTree } from '../pdf-page-tree-resolver.mjs';
import { tokenizePdfContentStream } from '../pdf-content-stream-tokenizer.mjs';
import { buildComparisonPackage, COMPARISON_PACKAGE_EXTENSION, COMPARISON_PACKAGE_MEDIA_TYPE, canonicalComparisonJson, validateComparisonPackage } from '../comparison-package-contract.mjs';
import { validateContentComparisonReceipt } from '../comparison-report.mjs';
import { authoritativeStorePair, comparisonCsv, contentReceiptBytes, directResult, productionContent, sourceBinding } from './comparison-production-boundary.mjs';
const FAMILY = 'comparison';
const DIGEST = /^[0-9a-f]{64}$/u;
function assertNotCancelled(signal) {
  if (signal?.aborted) fail('JOB_CANCELLED', 'The local comparison was cancelled.', 499);
}
function suppliedPair(ctx) {
  const suppliedPrimary = ctx.primaryPdf !== undefined; const suppliedRevision = ctx.revisionPdf !== undefined;
  const suppliedPrimaryDigest = ctx.primarySha256 !== undefined; const suppliedRevisionDigest = ctx.revisionSha256 !== undefined;
  if (ctx.demoFixture === true) {
    if (suppliedPrimary || suppliedRevision || suppliedPrimaryDigest || suppliedRevisionDigest) {
      fail('COMPARISON_DEMO_SOURCE_FORBIDDEN', 'demoFixture cannot be combined with supplied comparison sources.');
    }
    const primaryPdf = createTextPdf({ text: 'alpha beta gamma', title: 'Comparison demo primary' });
    const revisionPdf = createTextPdf({ text: 'alpha delta gamma', title: 'Comparison demo revision' });
    return Object.freeze({
      primaryPdf,
      revisionPdf,
      primary: Object.freeze({ id: 'demo-primary', sha256: sha256(primaryPdf), size: primaryPdf.length }),
      revision: Object.freeze({ id: 'demo-revision', sha256: sha256(revisionPdf), size: revisionPdf.length }),
      professionalProof: false,
      demoFixtureUsed: true,
    });
  }
  if (!suppliedPrimary || !suppliedRevision || !suppliedPrimaryDigest || !suppliedRevisionDigest) {
    fail('COMPARISON_SOURCE_REQUIRED', 'Comparison requires primaryPdf, revisionPdf, primarySha256, and revisionSha256 together.');
  }
  if (ctx.leftText !== undefined || ctx.rightText !== undefined) {
    fail('COMPARISON_UNBOUND_TEXT', 'Comparison rejects text overrides that are not bound to the supplied PDFs.');
  }
  const primaryPdf = requireBytes(ctx.primaryPdf, 'primaryPdf');
  const revisionPdf = requireBytes(ctx.revisionPdf, 'revisionPdf');
  const primaryDigest = sha256(primaryPdf);
  const revisionDigest = sha256(revisionPdf);
  if (!DIGEST.test(ctx.primarySha256) || !DIGEST.test(ctx.revisionSha256)
    || ctx.primarySha256 !== primaryDigest || ctx.revisionSha256 !== revisionDigest) {
    fail('SOURCE_VERSION_MISMATCH', 'Comparison source digests do not match the supplied PDF bytes.', 409);
  }
  return Object.freeze({
    primaryPdf,
    revisionPdf,
    primary: Object.freeze({ id: 'primary', sha256: primaryDigest, size: primaryPdf.length }),
    revision: Object.freeze({ id: 'revision', sha256: revisionDigest, size: revisionPdf.length }),
    professionalProof: false,
    demoFixtureUsed: false,
  });
}
function comparisonSourcePages(pdf, label) {
  try {
    const parsed = parsePdfStructure(pdf);
    const structure = parsed.xrefFlavor === 'classic' ? parseClassicPdfStructure(pdf) : parsed;
    const tree = resolvePdfPageTree({ structure, limits: { maxPages: 200 } });
    return Object.freeze(tree.pages.map((page) => {
      const shown = [];
      for (const content of page.contents) {
        const tokens = tokenizePdfContentStream({ sourceBytes: pdf, stream: content.stream }).tokens;
        for (let index = 0; index < tokens.length; index += 1) {
          const token = tokens[index];
          if (token.type !== 'operator') continue;
          if (['Tj', "'", '"'].includes(token.value)) {
            const operand = tokens[index - 1];
            if (operand?.type === 'string') shown.push(operand.bytes.toString('latin1'));
          } else if (token.value === 'TJ' && tokens[index - 1]?.type === 'array-end') {
            let depth = 1;
            for (let cursor = index - 2; cursor >= 0; cursor -= 1) {
              if (tokens[cursor].type === 'array-end') depth += 1;
              else if (tokens[cursor].type === 'array-start') {
                depth -= 1;
                if (depth === 0) {
                  for (const item of tokens.slice(cursor + 1, index - 1)) {
                    if (item.type === 'string') shown.push(item.bytes.toString('latin1'));
                  }
                  break;
                }
              }
            }
          }
        }
      }
      return shown.join(' ');
    }));
  } catch {
    fail('COMPARISON_SOURCE_UNSUPPORTED', `${label} cannot be compared by the bounded local PDF text extractor.`, 422);
  }
}
function sourceBoundContent(primaryPdf, revisionPdf) {
  const leftPages = comparisonSourcePages(primaryPdf, 'primaryPdf');
  const rightPages = comparisonSourcePages(revisionPdf, 'revisionPdf');
  const pageCount = Math.max(leftPages.length, rightPages.length);
  const pages = [];
  const stats = { added: 0, deleted: 0, unchanged: 0 };
  for (let index = 0; index < pageCount; index += 1) {
    const diff = diffTokens(leftPages[index] ?? '', rightPages[index] ?? '');
    for (const key of Object.keys(stats)) stats[key] += diff.stats[key];
    pages.push({
      page: index + 1,
      leftPresent: index < leftPages.length,
      rightPresent: index < rightPages.length,
      runs: diff.runs,
      stats: diff.stats,
    });
  }
  return Object.freeze({
    pages: Object.freeze(pages),
    stats: Object.freeze(stats),
    leftPages: leftPages.length,
    rightPages: rightPages.length,
  });
}
function sourceBoundReport(pair, signal) {
  assertNotCancelled(signal);
  const content = sourceBoundContent(pair.primaryPdf, pair.revisionPdf);
  // Re-read the supplied byte snapshots after extraction so a mutable caller
  // cannot alter either source while the comparison is being assembled.
  if (sha256(pair.primaryPdf) !== pair.primary.sha256
    || sha256(pair.revisionPdf) !== pair.revision.sha256) {
    fail('SOURCE_VERSION_MISMATCH', 'Comparison source bytes changed during processing.', 409);
  }
  assertNotCancelled(signal);
  const report = {
    kind: 'content',
    inputs: [{ role: 'primary', sha256: pair.primary.sha256 }, { role: 'secondary', sha256: pair.revision.sha256 }],
    stats: { ...content.stats, changed: content.stats.added + content.stats.deleted, leftPages: content.leftPages, rightPages: content.rightPages },
    pages: content.pages,
  };
  // This separately validates the data that the PDF extractor and diff algorithm produced.
  const stable = validateContentComparisonReceipt(report);
  const json = canonicalComparisonJson(stable);
  return Object.freeze({ content, report: stable, json, reportSha256: sha256(Buffer.from(json, 'utf8')) });
}
export const handlers = Object.freeze({
  async 'compare.content'(ctx = {}) {
    assertNotCancelled(ctx.signal);
    if (ctx.comparisonService !== undefined || ctx.service !== undefined) {
      const compared = await productionContent(ctx);
      return result('compare.content', {
        familyId: FAMILY,
        method: 'production-local-comparison-service',
        sourceDigests: Object.freeze({ primary: compared.binding.primary.sha256, revision: compared.binding.revision.sha256 }),
        inputs: compared.report.inputs,
        pages: compared.report.pages,
        stats: compared.report.stats,
        changed: compared.report.stats.changed > 0,
        reportSha256: compared.reportSha256,
        semanticValidation: 'validated-content-comparison-receipt',
        professionalProof: true,
        demoFixtureUsed: false,
        trustBoundary: Object.freeze({ sourceStore: true, sourceReread: true, productionService: true }),
      });
    }
    const pair = suppliedPair(ctx);
    const compared = sourceBoundReport(pair, ctx.signal);
    return directResult('compare.content', pair, {
      familyId: FAMILY,
      method: pair.demoFixtureUsed ? 'demo-source-bound-pdf-content-comparison' : 'bounded-source-bound-pdf-content-comparison',
      sourceDigests: sourceBinding(pair),
      inputs: compared.report.inputs,
      pages: compared.report.pages,
      runs: compared.report.pages.length === 1 ? compared.report.pages[0].runs : undefined,
      stats: compared.report.stats,
      changed: compared.report.stats.changed > 0,
      reportSha256: compared.reportSha256,
      semanticValidation: 'validated-content-comparison-receipt',
      limitations: Object.freeze(['Text-showing PDF content streams only; graphics, layout, and rendering differences are not asserted by this local subset.']),
    });
  },
  async 'compare.cross-format'(ctx = {}) {
    const left = requireString(ctx.leftText ?? 'alpha', 'leftText');
    const right = requireString(ctx.rightText ?? 'alpha', 'rightText');
    const diff = diffTokens(left, right);
    return result('compare.cross-format', {
      familyId: FAMILY,
      method: 'local-cross-format-text-compare',
      stats: diff.stats,
      changed: (diff.stats.added + diff.stats.deleted) > 0,
    });
  },
  async 'compare.report-export'(ctx = {}) {
    assertNotCancelled(ctx.signal);
    if (ctx.comparisonService !== undefined || ctx.service !== undefined) {
      const compared = await productionContent(ctx);
      if (typeof compared.service.exportContentReport !== 'function') {
        fail('COMPARISON_SERVICE_UNAVAILABLE', 'Professional report export requires the local exportContentReport service.', 503);
      }
      let exported;
      try { exported = compared.service.exportContentReport(compared.issuedReport, { format: 'json' }); }
      catch (error) { if (error?.code) throw error; fail('COMPARISON_SERVICE_FAILED', 'The local comparison report export failed.', 502); }
      const receipt = contentReceiptBytes(exported, compared.binding.primary.sha256, compared.binding.revision.sha256);
      return result('compare.report-export', {
        familyId: FAMILY,
        method: 'production-local-comparison-report-export',
        sourceDigests: Object.freeze({ primary: compared.binding.primary.sha256, revision: compared.binding.revision.sha256 }),
        inputs: compared.report.inputs,
        json: receipt.toString('utf8'),
        csv: comparisonCsv(compared.report),
        reportSha256: sha256(receipt),
        stats: compared.report.stats,
        semanticValidation: 'issued-and-validated-content-comparison-receipt',
        professionalProof: true,
        demoFixtureUsed: false,
      });
    }
    const pair = suppliedPair(ctx);
    {
      const compared = sourceBoundReport(pair, ctx.signal);
      const csv = comparisonCsv(compared.report);
      assertNotCancelled(ctx.signal);
      return directResult('compare.report-export', pair, {
        familyId: FAMILY,
        method: pair.demoFixtureUsed ? 'demo-source-bound-comparison-report-export' : 'bounded-source-bound-comparison-report-export',
        sourceDigests: sourceBinding(pair),
        inputs: compared.report.inputs,
        json: compared.json,
        csv,
        humanReadable: `Content comparison: ${compared.report.stats.added} added, ${compared.report.stats.deleted} deleted, ${compared.report.stats.unchanged} unchanged tokens.`,
        reportSha256: compared.reportSha256,
        stats: compared.report.stats,
        semanticValidation: 'validated-content-comparison-receipt',
        localTrustBoundary: 'The report is derived from supplied local PDF bytes and binds both source SHA-256 digests.',
      });
    }
  },
  async 'compare.package'(ctx = {}) {
    assertNotCancelled(ctx.signal);
    if (ctx.comparisonPackageService !== undefined || ctx.packageService !== undefined) {
      const binding = await authoritativeStorePair(ctx);
      const service = ctx.comparisonPackageService ?? ctx.packageService;
      if (typeof service?.create !== 'function') fail('COMPARISON_SERVICE_UNAVAILABLE', 'Professional package comparison requires the local package service.', 503);
      const readArtifact = typeof ctx.readArtifact === 'function'
        ? ctx.readArtifact
        : typeof service.readArtifact === 'function' ? service.readArtifact.bind(service) : null;
      if (!readArtifact) fail('COMPARISON_ARTIFACT_READBACK_REQUIRED', 'Professional package comparison requires an artifact reread authority.', 503);
      let receipt;
      try { receipt = await service.create(binding.primary.id, binding.revision.id, { primarySha256: binding.primary.sha256, revisionSha256: binding.revision.sha256, signal: ctx.signal }); }
      catch (error) { if (error?.code) throw error; fail('COMPARISON_SERVICE_FAILED', 'The local comparison package service failed.', 502); }
      let bytes;
      try { bytes = requireBytes(await readArtifact(receipt?.artifact), 'comparisonPackageArtifact'); }
      catch (error) { if (error?.code === 'INVALID_PROFESSIONAL_INPUT') fail('COMPARISON_ARTIFACT_INVALID', 'The artifact reread authority did not return bounded package bytes.', 502); throw error; }
      if (!receipt?.artifact || receipt.artifact.sha256 !== sha256(bytes) || receipt.artifact.size !== bytes.length) {
        fail('COMPARISON_ARTIFACT_INVALID', 'The reread comparison package does not match its retained artifact receipt.', 502);
      }
      const validated = validateComparisonPackage(bytes, binding.primary.sha256, binding.revision.sha256);
      return result('compare.package', {
        familyId: FAMILY,
        method: 'production-local-comparison-package-service',
        sourceDigests: Object.freeze({ primary: binding.primary.sha256, revision: binding.revision.sha256 }),
        artifact: receipt.artifact,
        bytes,
        outputSha256: receipt.artifact.sha256,
        manifest: validated.manifest,
        professionalProof: true,
        demoFixtureUsed: false,
        semanticValidation: 'retained-artifact-reread-and-deterministic-package-validation',
      });
    }
    const pair = suppliedPair(ctx);
    const compared = sourceBoundReport(pair, ctx.signal);
    const contentReceipt = contentReceiptBytes({
      mediaType: 'application/json',
      extension: 'json',
      data: compared.json,
    }, pair.primary.sha256, pair.revision.sha256);
    const built = buildComparisonPackage({
      primary: pair.primary,
      revision: pair.revision,
      contentReceipt,
    });
    assertNotCancelled(ctx.signal);
    const validated = validateComparisonPackage(
      built.bytes, pair.primary.sha256, pair.revision.sha256,
    );
    return directResult('compare.package', pair, {
      familyId: FAMILY,
      method: 'local-comparison-package-zip',
      mediaType: COMPARISON_PACKAGE_MEDIA_TYPE,
      extension: COMPARISON_PACKAGE_EXTENSION,
      outputSha256: built.sha256,
      sourceDigests: sourceBinding(pair),
      manifest: built.manifest,
      bytes: built.bytes,
      stats: compared.content.stats,
      semanticValidation: Object.freeze({
        contentReceipt: 'validated-content-comparison-receipt',
        package: 'validated-deterministic-comparison-package',
        entries: validated.entries.size,
      }),
      localTrustBoundary: 'The package contains validated local receipts only. It excludes both source PDF byte sequences.',
    });
  },
});
