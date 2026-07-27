import { types as nodeTypes } from 'node:util';
import { Readable } from 'node:stream';
import { createOperationProvenance } from './operation-provenance.mjs';
import { HostError } from './host-error.mjs';
import { ScannerDuplexJob } from './scanner-duplex-job.mjs';

const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function snapshot(value, seen = new Set(), depth = 0) {
  if (depth > 12 || value === null || typeof value === 'function' || typeof value === 'symbol'
    || typeof value === 'bigint' || nodeTypes.isProxy(value)) return null;
  if (typeof value !== 'object') {
    return typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value) ? value : null;
  }
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).length !== value.length + 1
        || descriptors.length?.enumerable === true) return null;
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        const child = snapshot(descriptor.value, seen, depth + 1);
        if (child === null && descriptor.value !== null) return null;
        output.push(child);
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return null;
    const output = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const child = snapshot(descriptor.value, seen, depth + 1);
      if (child === null && descriptor.value !== null) return null;
      output[key] = child;
    }
    return output;
  } catch { return null; }
  finally { seen.delete(value); }
}

function sameJson(left, right) {
  const leftValue = snapshot(left);
  const rightValue = snapshot(right);
  try {
    return leftValue !== null && rightValue !== null
      && JSON.stringify(leftValue) === JSON.stringify(rightValue);
  } catch { return false; }
}

function documentRecord(value) {
  const result = snapshot(value);
  return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
}

function inspectedPageCount(value) {
  try {
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'pageCount');
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
      && Number.isSafeInteger(descriptor.value) ? descriptor.value : null;
  } catch { return null; }
}

export class ScannerDuplexFeederService {
  #job; #store; #inspection;

  constructor({ job, store, inspection, ...jobOptions } = {}) {
    if (!store || typeof store.createDocument !== 'function'
      || typeof store.deleteDocument !== 'function' || typeof store.getDocument !== 'function'
      || typeof store.verifySource !== 'function') {
      throw new TypeError('scanner duplex service requires a document store boundary');
    }
    if (job !== undefined && (!job || typeof job.run !== 'function')) {
      throw new TypeError('scanner duplex service job is invalid');
    }
    if (!inspection || typeof inspection.inspect !== 'function') {
      throw new TypeError('scanner duplex service requires independent PDF inspection');
    }
    this.#job = job ?? new ScannerDuplexJob(jobOptions);
    this.#store = store;
    this.#inspection = inspection;
  }

  async acquire(value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    let acquired = null;
    let retainedID = null;
    let operationError = null;
    try {
      acquired = await this.#job.run(value, { signal });
      const operation = createOperationProvenance({
        type: 'scan-duplex-feeder',
        inputs: [],
        parameters: {
          profile: acquired.request.profile, deviceId: acquired.request.deviceId,
          source: 'feeder', duplex: true, color: acquired.request.color,
          dpi: acquired.request.dpi, pageCount: acquired.request.pageCount,
          maxPixels: acquired.request.maxPixels, format: 'PDF',
        },
        expected: {
          pageCount: acquired.request.pageCount, outputSha256: acquired.sha256,
          sourceFree: true,
        },
        validation: {
          passed: true,
          validators: ['pinned-helper-sha256', 'persistent-scanner-identity',
            'advertised-duplex-feeder', 'private-workspace', 'scanner-output-digest',
            'independent-pdf-structure', 'exact-page-count-reinspection'],
          outputSha256: acquired.sha256,
        },
      });
      const document = await this.#store.createDocument({
        stream: Readable.from([acquired.bytes]), displayName: 'duplex-scan.pdf',
        mediaType: 'application/pdf', operation,
      });
      const record = documentRecord(document);
      if (!record || !DOCUMENT_ID.test(record.id ?? '') || record.mediaType !== 'application/pdf'
        || record.size !== acquired.size || record.sha256 !== acquired.sha256
        || record.origin !== 'derived' || !sameJson(record.operation, operation)) {
        throw host('SCANNER_DUPLEX_DOCUMENT_INVALID', 'The document store did not bind the duplex PDF.', 502);
      }
      retainedID = record.id;
      const retained = documentRecord(this.#store.getDocument(record.id));
      if (!retained || retained.id !== record.id || retained.mediaType !== 'application/pdf'
        || retained.size !== acquired.size || retained.sha256 !== acquired.sha256
        || retained.origin !== 'derived' || !sameJson(retained.operation, operation)) {
        throw host('SCANNER_DUPLEX_DOCUMENT_INVALID', 'The retained duplex PDF could not be revalidated.', 502);
      }
      await this.#store.verifySource(record.id);
      let firstInspection;
      try { firstInspection = await this.#inspection.inspect(record.id, { signal }); }
      catch (error) {
        if (signal?.aborted) throw error;
        throw host('SCANNER_DUPLEX_PDF_INVALID', 'Independent inspection rejected the duplex PDF.', 502, error);
      }
      if (inspectedPageCount(firstInspection) !== acquired.request.pageCount) {
        throw host('SCANNER_DUPLEX_PDF_INVALID', 'Independent inspection rejected the duplex PDF page count.', 502);
      }
      await this.#store.verifySource(record.id);
      let secondInspection;
      try { secondInspection = await this.#inspection.inspect(record.id, { signal }); }
      catch (error) {
        if (signal?.aborted) throw error;
        throw host('SCANNER_DUPLEX_PDF_INVALID', 'Independent duplex PDF reinspection failed.', 502, error);
      }
      if (inspectedPageCount(secondInspection) !== acquired.request.pageCount) {
        throw host('SCANNER_DUPLEX_PDF_INVALID', 'Duplex PDF reinspection did not preserve the exact page count.', 502);
      }
      await this.#store.verifySource(record.id);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Duplex feeder acquisition was cancelled.', 499);
      return Object.freeze({
        kind: 'scan-duplex-feeder',
        document: Object.freeze(record),
        helperReport: Object.freeze({
          authority: 'unvalidated-helper-page-report-v1',
          pages: acquired.helperReportedPages,
        }),
        operation,
        evidence: Object.freeze({
          ...acquired.evidence, sourceFree: true, helperVerified: true,
          outputDigestBound: true, pdfStructureReinspected: true,
          helperPageMetadataValidated: false, localOnly: true,
        }),
      });
    } catch (error) {
      operationError = signal?.aborted || error?.code === 'ENGINE_CANCELLED'
        ? host('JOB_CANCELLED', 'Duplex feeder acquisition was cancelled.', 499, error)
        : error?.code === 'INVALID_SCANNER_DUPLEX_OPTIONS'
          ? host('INVALID_SCANNER_DUPLEX_OPTIONS', 'Duplex feeder options are invalid.', 400, error)
        : error instanceof HostError ? error
          : host('SCANNER_DUPLEX_FAILED', 'The duplex feeder service could not retain the scan.', 502, error);
      throw operationError;
    } finally {
      acquired?.bytes?.fill(0);
      if (retainedID && operationError) {
        try { await this.#store.deleteDocument(retainedID); }
        catch (error) {
          throw host('SCANNER_DUPLEX_REVOKE_FAILED', 'The invalid duplex document could not be revoked.', 500, error);
        }
      }
    }
  }
}
