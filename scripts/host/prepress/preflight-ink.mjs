import { buildPreflightReport, PREFLIGHT_PROFILES } from '../preflight-rules.mjs';
import { evidence, fail, parseInkCoverage } from './prepress-support.mjs';

export function createPreflightInkOperations(core) {
  return Object.freeze({
    async analyzeInkCoverage(documentId, { signal } = {}) {
      return core.withSource(documentId, signal, async ({
        sourcePath,
        info,
        workspace,
        runOptions,
        checkWorkspace,
      }) => {
        if (info.pageCount > core.limits.maxInkPages) {
          fail('INK_COVERAGE_LIMIT', `Ink coverage is limited to ${core.limits.maxInkPages} pages.`, 422);
        }
        const result = await core.ghostscript.execute('analyzeInkCoverage', {
          input: sourcePath,
          workspace,
        }, {
          ...runOptions(),
          maxStdoutBytes: 256 * 1024,
          maxStderrBytes: 128 * 1024,
        });
        await checkWorkspace();
        await core.assertInventory(workspace, new Set(['source.pdf']));
        const pages = parseInkCoverage(String(result.stdout ?? ''), core.limits.maxInkPages);
        if (pages.length !== info.pageCount) {
          fail('INK_COVERAGE_INVALID', 'Ink coverage row count does not match the PDF page count.', 502);
        }
        return Object.freeze({
          kind: 'ink-coverage',
          document: Object.freeze({ id: documentId, sha256: core.store.getDocument(documentId).sha256 }),
          pages,
          evidence: evidence('analyzeInkCoverage', 'ghostscript', [
            'Coverage is Ghostscript inckov CMYK aggregate per page; spot inks, ICC conversion, trapping, and press calibration are not validated.',
          ]),
        });
      });
    },

    async runPreflight(documentId, { profile = 'print-review', signal } = {}) {
      if (!PREFLIGHT_PROFILES.includes(profile)) {
        fail('INVALID_PREFLIGHT_PROFILE', 'Choose print-review or archive-review.');
      }
      if (!['listFonts', 'listImages', 'inspectStructure'].every(
        (name) => typeof core.pdf[name] === 'function',
      )) {
        fail('PREFLIGHT_UNAVAILABLE', 'Bounded resource and page-box inspection is unavailable.', 503);
      }
      return core.withSource(documentId, signal, async ({
        info,
        workspace,
        signal: jobSignal,
        checkWorkspace,
      }) => {
        const lastPage = Math.min(info.pageCount, core.limits.maxPreflightPages);
        const [fonts, images, structure] = await Promise.all([
          core.pdf.listFonts(documentId, { signal: jobSignal }),
          core.pdf.listImages(documentId, { signal: jobSignal }),
          core.pdf.inspectStructure(documentId, { firstPage: 1, lastPage, signal: jobSignal }),
        ]);
        await checkWorkspace();
        await core.assertInventory(workspace, new Set(['source.pdf']));
        const boundedStructure = structure.pageRange?.lastPage < info.pageCount
          ? Object.freeze({
            ...structure,
            pageRange: Object.freeze({ ...structure.pageRange, truncated: true }),
          })
          : structure;
        return buildPreflightReport({
          profile,
          document: core.store.getDocument(documentId),
          inspection: info,
          structure: boundedStructure,
          fonts,
          images,
        });
      });
    },
  });
}
