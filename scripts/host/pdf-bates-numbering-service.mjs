import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupPdfBatesNumberingJob, MAX_PDF_BATES_NUMBERING_JOB_MS, MAX_PDF_BATES_NUMBERING_SOURCE_BYTES, runPdfBatesNumberingJob } from './pdf-bates-numbering-job.mjs';
import { normalizePdfBatesNumbering, PDF_BATES_NUMBERING_PROFILE } from './pdf-bates-numbering-contract.mjs';
const METHODS = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'];
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined);
}
export class PdfBatesNumberingService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((m) => typeof store[m] !== 'function')) throw new TypeError('PdfBatesNumberingService requires a DocumentStore-compatible store.');
this.#store = store;
}
  async add(documentId, request, { signal } = {}) { if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
let frozen;
try { frozen = normalizePdfBatesNumbering(request);
} catch (error) { throw host('INVALID_PDF_BATES_NUMBERING_OPTIONS', 'The Bates request is invalid.', 400, error);
} if (frozen.profile !== PDF_BATES_NUMBERING_PROFILE) throw host('INVALID_PDF_BATES_NUMBERING_OPTIONS', 'The Bates profile is unsupported.', 400);
const source = this.#store.getDocument(documentId);
if (source.sha256 !== frozen.sourceSha256) throw host('SOURCE_VERSION_MISMATCH', 'The Bates source digest does not match the current document.', 409);
if (source.size > MAX_PDF_BATES_NUMBERING_SOURCE_BYTES) throw host('BATES_INPUT_TOO_LARGE', 'The Bates source exceeds its bound.', 413);
const deadline = createDeadline(signal, MAX_PDF_BATES_NUMBERING_JOB_MS);
const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
try { return await runPdfBatesNumberingJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle });
} catch (error) { if (signal?.aborted || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'Bates numbering was cancelled.', 499, error);
if (error instanceof HostError) throw error;
if (error?.code === 'UNSUPPORTED_PDF_BATES_NUMBERING_SOURCE') throw host('BATES_SOURCE_UNSUPPORTED', 'The source is outside the passive Bates subset.', 422, error);
if (error?.code === 'INVALID_PDF_BATES_NUMBERING_OUTPUT') throw host('BATES_OUTPUT_INVALID', 'Independent Bates inspection rejected the output.', 502, error);
throw host('BATES_FAILED', 'Bates numbering failed.', 502, error);
} finally { deadline.dispose();
await cleanupPdfBatesNumberingJob({ store: this.#store, lifecycle });
} }
}
export const BatesNumberingService = PdfBatesNumberingService;
