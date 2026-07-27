function invalid(message) { const error = new Error(message); error.code = 'INVALID_BATES_OPTIONS'; return error; }
const POSITIONS = new Set(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']);
function printable(value) { return typeof value === 'string' && value === value.normalize('NFC') && value.length <= 64 && /^[\x20-\x7E]*$/u.test(value); }
export function createBatesWorkflowController({ state, client, captureOperation, operationIsCurrent, finishOperation, render, announce, downloadDerivedArtifact }) {
  function snapshot() {
    if (!state.analysis?.documentId || state.host?.batesNumberingReady !== true) throw invalid('Bates numbering is unavailable for the current document.');
    const pages = String(state.batesPages ?? '').split(',').flatMap((part) => {
      const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim()); if (!match) throw invalid('Pages must use ascending values such as 1,3-5.');
      const first = Number(match[1]); const last = Number(match[2] ?? match[1]); if (first < 1 || last < first || last > 500 || last - first + 1 > 500) throw invalid('Pages are outside the bounded Bates range.');
      return Array.from({ length: last - first + 1 }, (_, index) => first + index);
    });
    if (!pages.length || pages.length > 500 || pages.some((page, index) => index && page <= pages[index - 1])) throw invalid('Pages must be unique and ascending.');
    const start = Number(state.batesStart); const padding = Number(state.batesPadding); const margin = Number(state.batesMargin); const fontSize = Number(state.batesFontSize);
    if (!Number.isSafeInteger(start) || start < 0 || start + pages.length - 1 > 999_999_999 || !Number.isSafeInteger(padding) || padding < 1 || padding > 12 || !printable(state.batesPrefix ?? '') || !printable(state.batesSuffix ?? '') || !POSITIONS.has(state.batesPosition) || !Number.isFinite(margin) || margin < 0 || margin > 1_000_000 || !Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 200) throw invalid('Bates options are outside the bounded printable and geometry contract.');
    return { profile: 'local-pdf-bates-numbering-v1', sourceSha256: state.analysis.sha256, pages, start, prefix: state.batesPrefix ?? '', suffix: state.batesSuffix ?? '', padding, position: state.batesPosition, margin, fontSize };
  }
  async function runBatesNumbering() {
    if (state.busyAction) return; let request;
    try { request = snapshot(); } catch (error) { state.batesStatus = 'error'; state.batesError = error.message; render(); return; }
    const operation = captureOperation(); state.batesStatus = 'loading'; state.batesError = null; render();
    try {
      const result = await client.runBatesNumbering(operation.documentId, request, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const downloaded = await downloadDerivedArtifact(result.artifact, operation, 'Source-bound Bates-numbered PDF downloaded.');
      if (!downloaded || !operationIsCurrent(operation)) { state.batesStatus = 'cancelled'; return; }
      state.batesResult = result; state.batesStatus = 'success'; announce('Source-bound Bates-numbered PDF downloaded.');
    } catch (error) {
      if (operationIsCurrent(operation)) { state.batesStatus = error?.code === 'JOB_CANCELLED' || error?.status === 499 ? 'cancelled' : 'error'; state.batesError = error?.message ?? String(error); }
    } finally { finishOperation(operation); render(); }
  }
  return Object.freeze({ runBatesNumbering });
}
