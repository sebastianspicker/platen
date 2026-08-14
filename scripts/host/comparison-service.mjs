import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';
import { DEFAULT_COMPARISON_LIMITS } from './comparison-contract.mjs';
import { compareAnnotationSnapshots, comparePixels, diffTokens, renderRedCyanOverlay } from './comparison-algorithms.mjs';
import { exportContentComparisonReport, issueContentComparisonReport } from './comparison-report.mjs';
import { decodePng, encodeRgbaPng } from './raster-png-codec.mjs';
function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function assertId(value, label) { if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) fail('INVALID_ID', `${label} must be a local document identifier.`); return value; }
function assertSignal(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'The comparison was cancelled.', 499); }
function normalizeLimits(limits) {
  const result = { ...DEFAULT_COMPARISON_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!(key in result) || !Number.isSafeInteger(value) || value < 1) {
      fail('INVALID_LIMITS', 'Comparison limits must be positive integers.');
    }
    result[key] = value;
  }
  return Object.freeze(result);
}
function makeDeadline(external, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Comparison deadline exceeded'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    finish() {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    },
    get timedOut() { return timedOut; },
  };
}
function mapAbort(error, deadline, external) {
  if (deadline.timedOut) {
    return new HostError(
      'COMPARISON_TIMEOUT', 'The local comparison exceeded its deadline.', 504,
      { cause: error },
    );
  }
  if (external?.aborted || error?.code === 'JOB_CANCELLED') {
    return new HostError(
      'JOB_CANCELLED', 'The comparison was cancelled.', 499, { cause: error },
    );
  }
  return error;
}
function assertPageLimits(left, right, limits) {
  if (!Number.isSafeInteger(left?.pageCount) || !Number.isSafeInteger(right?.pageCount)
    || left.pageCount > limits.maxPages || right.pageCount > limits.maxPages) {
    fail('COMPARISON_PAGE_LIMIT', `Comparison is limited to ${limits.maxPages} pages per document.`, 422);
  }
}
function assertPairedRenderPage(page, left, right, mode) {
  if (page > left.pageCount || page > right.pageCount) {
    fail(`${mode}_UNPAIRED_PAGE`, `The requested ${mode.toLowerCase().replaceAll('_', ' ')} page must exist in both local PDF sources.`, 422);
  }
}
function assertPdfPair(primary, secondary) {
  if (!primary || !secondary || primary.id === secondary.id
    || primary.mediaType !== 'application/pdf' || secondary.mediaType !== 'application/pdf'
    || !/^[0-9a-f]{64}$/u.test(primary.sha256 ?? '') || !/^[0-9a-f]{64}$/u.test(secondary.sha256 ?? '')
    || !Number.isSafeInteger(primary.size) || !Number.isSafeInteger(secondary.size)
    || primary.size < 1 || secondary.size < 1) {
    fail('INVALID_COMPARISON_PAIR', 'Comparison requires two distinct immutable local PDF records.', 422);
  }
}
function inputs(primary, secondary) {
  return Object.freeze([
    Object.freeze({ documentId: primary.id, sha256: primary.sha256, role: 'primary' }),
    Object.freeze({ documentId: secondary.id, sha256: secondary.sha256, role: 'secondary' }),
  ]);
}
async function verifyPair(store, primary, secondary) {
  const results = await Promise.all([store.verifySource(primary.id), store.verifySource(secondary.id)]);
  if (results.some((verified) => verified !== true)) {
    fail('SOURCE_INTEGRITY_FAILED', 'A comparison source could not be verified as unchanged.', 409);
  }
  for (const [before, after] of [[primary, store.getDocument(primary.id)], [secondary, store.getDocument(secondary.id)]]) {
    if (!after || after.id !== before.id || after.sha256 !== before.sha256
      || after.size !== before.size || after.mediaType !== before.mediaType) {
      fail('SOURCE_VERSION_MISMATCH', 'A comparison source changed during processing.', 409);
    }
  }
}
const OVERLAY_DPI = 72;
function renderedPane(role, png, limits) {
  if (!Buffer.isBuffer(png)) fail('SIDE_BY_SIDE_IMAGE_LIMIT', 'A rendered side-by-side pane exceeds the local output limit.', 413);
  const decoded = decodePng(png, limits.maxPixelsPerPage);
  const canonical = encodeRgbaPng(decoded);
  if (canonical.length > limits.maxDifferenceImageBytes) fail('SIDE_BY_SIDE_IMAGE_LIMIT', 'A rendered side-by-side pane exceeds the local output limit.', 413);
  const checked = decodePng(canonical, limits.maxPixelsPerPage);
  return Object.freeze({
    role,
    mediaType: 'image/png',
    encoding: 'base64',
    sha256: sha256(canonical),
    size: canonical.length,
    width: checked.width,
    height: checked.height,
    data: canonical.toString('base64'),
  });
}
export class ComparisonService {
  #store;
  #pdf;
  #workspace;
  #limits;
  constructor({ store, pdfService, workspaceState = null, limits } = {}) {
    if (!store || typeof store.getDocument !== 'function'
      || typeof store.verifySource !== 'function') {
      throw new TypeError('ComparisonService requires a DocumentStore-compatible store.');
    }
    if (!pdfService || typeof pdfService.inspect !== 'function'
      || typeof pdfService.extractText !== 'function'
      || typeof pdfService.renderThumbnail !== 'function') {
      throw new TypeError('ComparisonService requires PdfService text and render methods.');
    }
    this.#store = store;
    this.#pdf = pdfService;
    this.#workspace = workspaceState;
    this.#limits = normalizeLimits(limits);
  }
  async compareContent(primaryDocumentId, secondaryDocumentId, { signal } = {}) {
    return this.#withDocuments(primaryDocumentId, secondaryDocumentId, signal, async (primary, secondary, deadline) => {
        const [leftInfo, rightInfo] = await Promise.all([
          this.#pdf.inspect(primary.id, { signal: deadline.signal }),
          this.#pdf.inspect(secondary.id, { signal: deadline.signal }),
        ]);
        assertPageLimits(leftInfo, rightInfo, this.#limits);
        const [leftPages, rightPages] = await Promise.all([
          this.#pdf.extractText(primary.id, leftInfo.pageCount, { signal: deadline.signal }),
          this.#pdf.extractText(secondary.id, rightInfo.pageCount, { signal: deadline.signal }),
        ]);
        const pageCount = Math.max(leftPages.length, rightPages.length);
        const pages = [];
        let added = 0;
        let deleted = 0;
        let unchanged = 0;
        for (let index = 0; index < pageCount; index += 1) {
          assertSignal(deadline.signal);
          const diff = diffTokens(
            leftPages[index]?.text ?? '',
            rightPages[index]?.text ?? '',
            this.#limits.maxTokensPerPage,
          );
          added += diff.stats.added;
          deleted += diff.stats.deleted;
          unchanged += diff.stats.unchanged;
          pages.push(Object.freeze({
            page: index + 1,
            leftPresent: Boolean(leftPages[index]),
            rightPresent: Boolean(rightPages[index]),
            ...diff,
          }));
        }
        return issueContentComparisonReport(Object.freeze({
          kind: 'content',
          inputs: inputs(primary, secondary),
          stats: Object.freeze({
            added, deleted, unchanged, changed: added + deleted,
            leftPages: leftPages.length, rightPages: rightPages.length,
          }),
          pages: Object.freeze(pages),
        }));
      });
  }
  async comparePixels(primaryDocumentId, secondaryDocumentId, {
    pages = null, dpi = 72, signal,
  } = {}) {
    if (!Number.isSafeInteger(dpi) || dpi < 36 || dpi > 240) {
      fail('INVALID_PARAMETER', 'dpi must be an integer from 36 through 240.');
    }
    return this.#withDocuments(primaryDocumentId, secondaryDocumentId, signal, async (primary, secondary, deadline) => {
        const [leftInfo, rightInfo] = await Promise.all([
          this.#pdf.inspect(primary.id, { signal: deadline.signal }),
          this.#pdf.inspect(secondary.id, { signal: deadline.signal }),
        ]);
        assertPageLimits(leftInfo, rightInfo, this.#limits);
        const maximumPage = Math.max(leftInfo.pageCount, rightInfo.pageCount);
        const selected = pages ?? Array.from(
          { length: maximumPage }, (_, index) => index + 1,
        );
        if (!Array.isArray(selected) || selected.length < 1
          || selected.length > this.#limits.maxPages
          || selected.some((page) => !Number.isSafeInteger(page)
            || page < 1 || page > maximumPage)) {
          fail('INVALID_PAGES', 'Choose bounded valid page numbers for this comparison.');
        }
        const result = [];
        for (const page of [...new Set(selected)]) {
          assertSignal(deadline.signal);
          if (page > leftInfo.pageCount || page > rightInfo.pageCount) {
            result.push(Object.freeze({
              page, status: 'unpaired-page',
              leftPresent: page <= leftInfo.pageCount,
              rightPresent: page <= rightInfo.pageCount,
            }));
            continue;
          }
          const [left, right] = await Promise.all([
            this.#pdf.renderThumbnail(primary.id, { page, dpi, signal: deadline.signal }),
            this.#pdf.renderThumbnail(secondary.id, { page, dpi, signal: deadline.signal }),
          ]);
          const { differencePng, ...metric } = comparePixels(left, right, this.#limits);
          result.push(Object.freeze({
            page,
            status: 'compared',
            ...metric,
            differenceImage: Object.freeze({
              format: 'image/png', encoding: 'base64',
              sha256: sha256(differencePng), data: differencePng.toString('base64'),
            }),
          }));
        }
        const compared = result.filter(({ status }) => status === 'compared');
        return Object.freeze({
          kind: 'pixel', inputs: inputs(primary, secondary), dpi,
          stats: Object.freeze({
            comparedPages: compared.length,
            changedPixels: compared.reduce((sum, page) => sum + page.changedPixels, 0),
            comparedPixels: compared.reduce((sum, page) => sum + page.comparedPixels, 0),
          }),
          pages: Object.freeze(result),
        });
      });
  }
  async compareCrossFormat(primaryDocumentId, secondaryDocumentId, options = {}) {
    const content = await this.compareContent(primaryDocumentId, secondaryDocumentId, options);
    return Object.freeze({
      kind: 'cross-format',
      conversionPerformed: false,
      semantics: 'Both inputs must already be local PDF document IDs; this service does not convert source formats.',
      content,
    });
  }
  async describeOverlay(primaryDocumentId, secondaryDocumentId, {
    page = 1, opacity = 0.5, signal,
  } = {}) {
    if (!Number.isSafeInteger(page) || page < 1
      || typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity <= 0 || opacity >= 1) {
      fail('INVALID_PARAMETER', 'The requested overlay parameters are invalid.');
    }
    return this.#withDocuments(primaryDocumentId, secondaryDocumentId, signal, async (primary, secondary, deadline) => {
        const [leftInfo, rightInfo] = await Promise.all([
          this.#pdf.inspect(primary.id, { signal: deadline.signal }),
          this.#pdf.inspect(secondary.id, { signal: deadline.signal }),
        ]);
        assertPageLimits(leftInfo, rightInfo, this.#limits);
        assertPairedRenderPage(page, leftInfo, rightInfo, 'OVERLAY');
        if (typeof this.#pdf.renderOverlayPageExactDpi !== 'function') {
          fail('OVERLAY_RENDER_UNAVAILABLE', 'Exact-DPI overlay rendering requires the local PDF render authority.', 503);
        }
        const [left, right] = await Promise.all([
          this.#pdf.renderOverlayPageExactDpi(primary.id, { page, dpi: OVERLAY_DPI, signal: deadline.signal }),
          this.#pdf.renderOverlayPageExactDpi(secondary.id, { page, dpi: OVERLAY_DPI, signal: deadline.signal }),
        ]);
        assertSignal(deadline.signal);
        const rendered = renderRedCyanOverlay(left, right, opacity, this.#limits);
        const outputSha256 = sha256(rendered.overlayPng);
        return Object.freeze({
          kind: 'overlay',
          inputs: inputs(primary, secondary),
          page,
          dpi: OVERLAY_DPI,
          opacity,
          semantics: 'primary-red-secondary-cyan',
          image: Object.freeze({
            mediaType: 'image/png',
            encoding: 'base64',
            sha256: outputSha256,
            size: rendered.overlayPng.length,
            data: rendered.overlayPng.toString('base64'),
          }),
          validation: Object.freeze({
            decoded: true,
            width: rendered.width,
            height: rendered.height,
            outputSha256,
            sourceReread: true,
          }),
        });
      });
  }
  async describeSideBySide(primaryDocumentId, secondaryDocumentId, { page = 1, signal } = {}) {
    if (!Number.isSafeInteger(page) || page < 1) {
      fail('INVALID_PARAMETER', 'The requested side-by-side page is invalid.');
    }
    return this.#withDocuments(primaryDocumentId, secondaryDocumentId, signal, async (primary, secondary, deadline) => {
      const [leftInfo, rightInfo] = await Promise.all([
        this.#pdf.inspect(primary.id, { signal: deadline.signal }),
        this.#pdf.inspect(secondary.id, { signal: deadline.signal }),
      ]);
      assertPageLimits(leftInfo, rightInfo, this.#limits);
      assertPairedRenderPage(page, leftInfo, rightInfo, 'SIDE_BY_SIDE');
      if (typeof this.#pdf.renderOverlayPageExactDpi !== 'function') {
        fail('SIDE_BY_SIDE_RENDER_UNAVAILABLE', 'Exact-DPI side-by-side rendering requires the local PDF render authority.', 503);
      }
      const [primaryPng, secondaryPng] = await Promise.all([
        this.#pdf.renderOverlayPageExactDpi(primary.id, { page, dpi: OVERLAY_DPI, signal: deadline.signal }),
        this.#pdf.renderOverlayPageExactDpi(secondary.id, { page, dpi: OVERLAY_DPI, signal: deadline.signal }),
      ]);
      assertSignal(deadline.signal);
      return Object.freeze({
        kind: 'side-by-side',
        inputs: inputs(primary, secondary),
        page,
        dpi: OVERLAY_DPI,
        semantics: 'primary-left-secondary-right',
        panes: Object.freeze([
          renderedPane('primary', primaryPng, this.#limits),
          renderedPane('secondary', secondaryPng, this.#limits),
        ]),
        validation: Object.freeze({ sourceReread: true }),
      });
    });
  }
  async compareAnnotations(primaryDocumentId, secondaryDocumentId, { signal } = {}) {
    if (!this.#workspace || typeof this.#workspace.exportSnapshot !== 'function') {
      fail(
        'ANNOTATION_COMPARISON_UNAVAILABLE',
        'Annotation comparison requires the local WorkspaceStateStore.',
        503,
      );
    }
    return this.#withDocuments(primaryDocumentId, secondaryDocumentId, signal, async (primary, secondary) => {
        const left = this.#workspace.exportSnapshot(primary.id).namespaces.annotations;
        const right = this.#workspace.exportSnapshot(secondary.id).namespaces.annotations;
        const result = compareAnnotationSnapshots(left, right);
        return Object.freeze({
          kind: 'annotations',
          inputs: inputs(primary, secondary),
          stats: Object.freeze({
            added: result.added.length, deleted: result.deleted.length,
            changed: result.changed.length, unchanged: result.unchanged.length,
          }),
          added: Object.freeze(result.added),
          deleted: Object.freeze(result.deleted),
          changed: Object.freeze(result.changed),
          unchanged: Object.freeze(result.unchanged),
        });
      });
  }
  async compareBatch(pairs, { mode = 'content', signal } = {}) {
    if (!Array.isArray(pairs) || !pairs.length || pairs.length > this.#limits.maxPairs) {
      fail(
        'BATCH_LIMIT',
        `Compare from one through ${this.#limits.maxPairs} document pairs per batch.`,
        422,
      );
    }
    if (!['content', 'pixel'].includes(mode)) {
      fail(
        'UNSUPPORTED_COMPARISON_MODE',
        'Batch comparison supports content or pixel modes only.',
      );
    }
    const reports = [];
    for (const pair of pairs) {
      assertSignal(signal);
      if (!pair || typeof pair !== 'object') {
        fail('INVALID_BATCH_PAIR', 'Each batch item must contain two document identifiers.');
      }
      reports.push(await (mode === 'content'
        ? this.compareContent(pair.primaryDocumentId, pair.secondaryDocumentId, { signal })
        : this.comparePixels(pair.primaryDocumentId, pair.secondaryDocumentId, {
          pages: pair.pages, dpi: pair.dpi ?? 72, signal,
        })));
    }
    return Object.freeze({ kind: 'batch', mode, reports: Object.freeze(reports) });
  }
  exportContentReport(report, options = {}) {
    return exportContentComparisonReport(report, options);
  }
  async #withDocuments(leftId, rightId, external, action) {
    const primary = this.#store.getDocument(assertId(leftId, 'primaryDocumentId'));
    const secondary = this.#store.getDocument(assertId(rightId, 'secondaryDocumentId'));
    assertPdfPair(primary, secondary);
    const deadline = makeDeadline(external, this.#limits.deadlineMs);
    try {
      await verifyPair(this.#store, primary, secondary);
      const result = await action(primary, secondary, deadline);
      await verifyPair(this.#store, primary, secondary);
      assertSignal(deadline.signal);
      return result;
    } catch (error) {
      throw mapAbort(error, deadline, external);
    } finally {
      deadline.finish();
    }
  }
}
