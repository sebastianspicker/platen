import { runProcess } from '../../process-runner.mjs';
import { parsePdfkitAecMeasurementResponse } from './aec-response.mjs';
import { parsePdfkitResponse } from './inspection-response.mjs';
import { parsePdfkitInkAnnotationResponse, parsePdfkitLineAnnotationResponse, parsePdfkitLocalGoToRemovalResponse, parsePdfkitLocalGoToResponse, parsePdfkitMutationResponse, parsePdfkitOutlineBookmarkRemovalResponse, parsePdfkitOutlineBookmarkRenameResponse, parsePdfkitOutlineBookmarkResponse, parsePdfkitTargetedMutationResponse } from './mutation-response.mjs';
import { parsePdfkitProtectionRemovalResponse, parsePdfkitProtectionResponse } from './protection-response.mjs';
import { responseError, PDFKIT_MAX_RESPONSE_BYTES } from './response-common.mjs';
import { parsePdfkitMetadataSanitizationResponse } from './sanitization-response.mjs';
import { parsePdfkitTextFieldWidgetResponse } from '../../pdfkit-text-field-widget-contract.mjs';
import { absolutePath, PDFKIT_MAX_REQUEST_BYTES, validatedPrivateWorkspace, validatedProtectionWorkspace } from './workspace.mjs';

const PDFKIT_MAX_TIMEOUT_MS = 30_000;

function safeRunOptions(runOptions) {
  if (runOptions === undefined) return Object.freeze({});
  if (!runOptions || typeof runOptions !== 'object' || Array.isArray(runOptions)) throw new TypeError('runOptions must be an object');
  const safe = {};
  if (runOptions.signal !== undefined) {
    if (!(runOptions.signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    safe.signal = runOptions.signal;
  }
  if (runOptions.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(runOptions.timeoutMs) || runOptions.timeoutMs < 1 || runOptions.timeoutMs > PDFKIT_MAX_TIMEOUT_MS) {
      throw new TypeError(`timeoutMs must be an integer from 1 through ${PDFKIT_MAX_TIMEOUT_MS}`);
    }
    safe.timeoutMs = runOptions.timeoutMs;
  }
  return Object.freeze(safe);
}

export class PDFKitAdapter {
  #executable; #expectedSha256; #runner; #verifyExecutable;

  constructor({ executable, expectedSha256, runner = runProcess, verifyExecutable } = {}) {
    this.#executable = absolutePath(executable, 'executable');
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha256)) throw new TypeError('expectedSha256 must be a SHA-256 digest');
    if (typeof verifyExecutable !== 'function') throw new TypeError('verifyExecutable must be a function');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#expectedSha256 = expectedSha256.toLowerCase(); this.#verifyExecutable = verifyExecutable; this.#runner = runner;
  }

  async inspect(input, options = {}) { return this.#run(input, options, parsePdfkitResponse); }
  async mutate(input, options = {}) { return this.#run(input, options, parsePdfkitMutationResponse); }
  async targetedMutate(input, options = {}) { return this.#run(input, options, parsePdfkitTargetedMutationResponse); }
  async addLocalGoToLink(input, options = {}) { return this.#run(input, options, parsePdfkitLocalGoToResponse); }
  async removeLocalGoToLink(input, options = {}) { return this.#run(input, options, parsePdfkitLocalGoToRemovalResponse); }
  async appendOutlineBookmark(input, options = {}) { return this.#run(input, options, parsePdfkitOutlineBookmarkResponse); }
  async removeOutlineBookmark(input, options = {}) { return this.#run(input, options, parsePdfkitOutlineBookmarkRemovalResponse); }
  async renameOutlineBookmark(input, options = {}) { return this.#run(input, options, parsePdfkitOutlineBookmarkRenameResponse); }
  async addLineAnnotation(input, options = {}) { return this.#run(input, options, parsePdfkitLineAnnotationResponse); }
  async addInkAnnotation(input, options = {}) { return this.#run(input, options, parsePdfkitInkAnnotationResponse); }
  async addTextFieldWidget(input, options = {}) { return this.#run(input, options, parsePdfkitTextFieldWidgetResponse); }
  async applyAecMeasurement(input, options = {}) { return this.#run(input, options, parsePdfkitAecMeasurementResponse); }
  async protect(input, options = {}) { return this.#runStdin(input, options, '--protect-stdin', parsePdfkitProtectionResponse); }
  async removeProtection(input, options = {}) { return this.#runStdin(input, options, '--remove-protection-stdin', parsePdfkitProtectionRemovalResponse); }
  async sanitizeMetadata(input, options = {}) { return this.#runStdin(input, options, '--sanitize-metadata-stdin', parsePdfkitMetadataSanitizationResponse); }

  async #verify() {
    try { await this.#verifyExecutable({ executable: this.#executable, expectedSha256: this.#expectedSha256 }); }
    catch { throw responseError('PDFKIT_HELPER_UNTRUSTED'); }
  }

  async #runStdin({ workspacePath, requestBuffer }, runOptions, operation, parseResponse) {
    const workspace = await validatedProtectionWorkspace(workspacePath);
    if (!Buffer.isBuffer(requestBuffer) || requestBuffer.length < 1 || requestBuffer.length > PDFKIT_MAX_REQUEST_BYTES) {
      throw new TypeError('requestBuffer must be a bounded non-empty Buffer');
    }
    const safeOptions = safeRunOptions(runOptions); await this.#verify();
    let response;
    try { response = await this.#runner({ ...safeOptions, executable: this.#executable, args: [operation], cwd: workspace, stdin: requestBuffer, maxStdoutBytes: PDFKIT_MAX_RESPONSE_BYTES, maxStderrBytes: 4_096 }); }
    catch { throw responseError('PDFKIT_HELPER_FAILED'); }
    return parseResponse(response.stdout);
  }

  async #run({ workspacePath, requestPath }, runOptions, parseResponse) {
    const { workspace, request } = await validatedPrivateWorkspace(workspacePath, requestPath);
    const safeOptions = safeRunOptions(runOptions); await this.#verify();
    let response;
    try { response = await this.#runner({ ...safeOptions, executable: this.#executable, args: ['--request', request], cwd: workspace, maxStdoutBytes: PDFKIT_MAX_RESPONSE_BYTES, maxStderrBytes: 4_096 }); }
    catch { throw responseError('PDFKIT_HELPER_FAILED'); }
    return parseResponse(response.stdout);
  }
}
