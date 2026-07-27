import { HostError } from '../host-error.mjs';
import { OUTPUT_INTENT_PROFILE } from '../prepress/output-intent-contract.mjs';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE, AUTOMATION_OUTPUT_INTENT_TYPE,
  automationPresetDescriptor, expandAutomationPreset, fullPageRedactionPayload,
  invalidOperation, normalizedOcrOptions, OPAQUE_ID, ocrPayload, outputIntentPayload,
  presetPayload,
  SHA256, sourcePayload,
} from './automation-operation-contract.mjs';
import {
  inspectionReceipt, ocrReceipt, outputIntentReceipt, fullPageRedactionReceipt,
  validatedFullPageRedaction, validatedFullPageRedactionBatch, validatedOcrOutput, validatedOutputIntent,
} from './automation-operation-results.mjs';
import { FULL_PAGE_REDACTION_BATCH_PROFILE, FULL_PAGE_REDACTION_PROFILE } from '../../../src/core/pdf-full-page-redaction-contract.js';
import { createReadStream } from 'node:fs';
import { AUTOMATION_SEQUENCE_TYPE, automationSequenceDescriptor } from './automation-sequence-contract.mjs';
import { executeAutomationSequence } from './automation-sequence-execution.mjs';

export {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE, AUTOMATION_OUTPUT_INTENT_TYPE,
  AUTOMATION_INSPECT_PRESET, AUTOMATION_OCR_PRESET, AUTOMATION_OUTPUT_INTENT_PRESET,
  AUTOMATION_PRESET_IDS, AUTOMATION_PRESET_SCHEMA_VERSION,
} from './automation-operation-contract.mjs';
export { AUTOMATION_SEQUENCE_TYPE, AUTOMATION_SEQUENCE_IDS, automationSequenceDescriptor } from './automation-sequence-contract.mjs';

async function* abortableSource(stream, signal) {
  for await (const chunk of stream) {
    if (signal?.aborted) {
      throw new HostError('JOB_CANCELLED', 'Automation operation was cancelled.', 499);
    }
    yield chunk;
  }
}

function checkedExecution(type, dependencies) {
  const { sources, store, service, fullPageRedaction, outputIntentService } = dependencies;
  if ([
    AUTOMATION_INSPECT_TYPE,
    AUTOMATION_OCR_TYPE,
    AUTOMATION_OUTPUT_INTENT_TYPE,
    AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  ].includes(type) === false) {
    invalidOperation('Automation operation is not allowlisted.');
  }
  if (!sources || !store || !service || typeof sources.openVerified !== 'function'
    || typeof store.createDocument !== 'function' || typeof store.deleteDocument !== 'function'
    || (type === AUTOMATION_INSPECT_TYPE && typeof service.inspect !== 'function')
    || (type === AUTOMATION_OCR_TYPE && (typeof service.ocrDocument !== 'function'
      || typeof sources.stagePromotedArtifact !== 'function'
      || typeof sources.discardCreatedOutput !== 'function'
      || typeof store.getArtifact !== 'function'))
    || (type === AUTOMATION_OUTPUT_INTENT_TYPE
      && (typeof outputIntentService?.assign !== 'function'
        || typeof sources.stagePromotedArtifact !== 'function'
        || typeof sources.discardCreatedOutput !== 'function'
        || typeof store.getArtifact !== 'function'))
    || (type === AUTOMATION_FULL_PAGE_REDACTION_TYPE
      && (typeof fullPageRedaction?.update !== 'function'
        || typeof sources.stagePromotedArtifact !== 'function'
        || typeof sources.discardCreatedOutput !== 'function'
        || typeof store.createDocument !== 'function'
        || typeof store.getArtifact !== 'function'))) {
    throw new TypeError('Automation execution requires source storage, DocumentStore, and PdfService.');
  }
}

function checkedSource(source) {
  if (!source || !OPAQUE_ID.test(source.id) || !SHA256.test(source.sha256)) {
    invalidOperation('Automation source is invalid.');
  }
}

function operationRequest(type, payload) {
  if (hasPresetField(payload)) {
    const preset = presetPayload(payload);
    const descriptor = automationPresetDescriptor(preset.preset);
    if (descriptor.type !== type) invalidOperation('Automation preset does not match the job type.');
    const expanded = expandAutomationPreset(payload);
    if (type === AUTOMATION_OCR_TYPE) return ocrPayload(expanded);
    if (type === AUTOMATION_OUTPUT_INTENT_TYPE) return outputIntentPayload(expanded);
    return sourcePayload(expanded);
  }
  if (type === AUTOMATION_OCR_TYPE) return ocrPayload(payload);
  if (type === AUTOMATION_OUTPUT_INTENT_TYPE) return outputIntentPayload(payload);
  if (type === AUTOMATION_FULL_PAGE_REDACTION_TYPE) return fullPageRedactionPayload(payload);
  return sourcePayload(payload);
}

function hasPresetField(payload) {
  try {
    const descriptor = payload && Object.getOwnPropertyDescriptor(payload, 'preset');
    if (!descriptor) return false;
    if (!Object.hasOwn(descriptor, 'value')) invalidOperation('Automation preset payload is invalid.');
    return descriptor.value !== undefined;
  } catch (error) {
    if (error?.code === 'INVALID_AUTOMATION_OPERATION') throw error;
    invalidOperation('Automation preset payload is invalid.');
  }
}

function requestedPreset(payload) {
  if (!hasPresetField(payload)) return null;
  return presetPayload(payload).preset;
}

function receiptWithPreset(receipt, preset) {
  return preset ? Object.freeze({ ...receipt, preset }) : receipt;
}

async function createWorkingDocumentFromArtifact(store, checkedArtifact, signal) {
  let artifact;
  try {
    artifact = store.getArtifact(checkedArtifact.id);
  } catch (error) {
    throw new HostError(
      'AUTOMATION_RESULT_INVALID',
      'Automation full-page redaction intermediate artifact is unavailable.',
      502,
      { cause: error },
    );
  }
  if (!artifact || artifact.id !== checkedArtifact.id
    || artifact.documentId !== checkedArtifact.documentId
    || artifact.sha256 !== checkedArtifact.sha256
    || artifact.size !== checkedArtifact.size
    || artifact.mediaType !== 'application/pdf'
    || typeof artifact.filePath !== 'string') {
    throw new HostError(
      'AUTOMATION_RESULT_INVALID',
      'Automation full-page redaction intermediate artifact is invalid.',
      502,
    );
  }
  const working = await store.createDocument({
    stream: createReadStream(artifact.filePath),
    displayName: artifact.displayName,
    mediaType: artifact.mediaType,
    operation: artifact.operation,
  });
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'Full-page redaction was cancelled.', 499);
  return working;
}

async function executeFullPageRedaction(context) {
  const { source, request, sourceDocument, fullPageRedaction, signal } = context;
  const created = [sourceDocument];
  let current = sourceDocument;
  let currentDigest = source.sha256;
  let checked = null;
  let finalChecked = null;
  if (request.pages.length > 1) {
    if (typeof fullPageRedaction.updateBatch !== 'function') throw new HostError('AUTOMATION_FULL_PAGE_REDACTION_BATCH_UNAVAILABLE', 'Automation full-page redaction batch service is unavailable.', 503);
    const derived = await fullPageRedaction.updateBatch(sourceDocument.id, {
      profile: FULL_PAGE_REDACTION_BATCH_PROFILE,
      sourceSha256: source.sha256,
      pages: request.pages,
    }, { sourceSha256: source.sha256, signal });
    finalChecked = validatedFullPageRedactionBatch(source, derived, sourceDocument.id, source.sha256, request.pages);
    return Object.freeze({ created, checked: finalChecked, pages: request.pages });
  }
  for (const page of request.pages) {
    if (signal?.aborted) {
      throw new HostError('JOB_CANCELLED', 'Full-page redaction was cancelled.', 499);
    }
    const derived = await fullPageRedaction.update(current.id, {
      profile: FULL_PAGE_REDACTION_PROFILE,
      sourceSha256: currentDigest,
      page,
    }, { sourceSha256: currentDigest, signal });
    checked = validatedFullPageRedaction(source, derived, current.id, currentDigest);
    if (checked.redaction.page !== page) {
      throw new HostError('AUTOMATION_RESULT_INVALID', 'Automation full-page redaction output was not bound to the requested page.', 502);
    }
    currentDigest = checked.sourceDigest;
    finalChecked = checked;
    if (page !== request.pages[request.pages.length - 1]) {
      current = await createWorkingDocumentFromArtifact(context.store, checked.artifact, signal);
      if (current.sha256 !== checked.artifact.sha256) {
        throw new HostError(
          'AUTOMATION_RESULT_INVALID',
          'Automation full-page redaction output changed while chaining.', 502,
        );
      }
      created.push(current);
      currentDigest = current.sha256;
    }
  }
  return Object.freeze({
    created,
    checked: finalChecked,
    pages: request.pages,
  });
}

async function executeDerived(type, context) {
  const {
    source, request, document, service, outputIntentService, signal,
  } = context;
  if (type === AUTOMATION_OUTPUT_INTENT_TYPE) {
    const output = await outputIntentService.assign(document.id, {
      profile: OUTPUT_INTENT_PROFILE, sourceSha256: source.sha256,
    }, { signal });
    return Object.freeze({
      checked: validatedOutputIntent(source, output, document.id),
      receipt: outputIntentReceipt,
    });
  }
  const output = await service.ocrDocument(document.id, {
    language: request.language, cleanupPreset: request.cleanupPreset,
    segmentation: request.segmentation, userDictionary: request.userDictionary, signal,
  });
  return Object.freeze({
    checked: validatedOcrOutput(source, request, output, document.id),
    receipt: (checked, pendingOutput) => ocrReceipt(source, request, checked, pendingOutput),
  });
}

export class AutomationOperationRegistry {
  enqueueSequenceRequest(source, sequenceId) { checkedSource(source); automationSequenceDescriptor(sequenceId); return Object.freeze({ type: AUTOMATION_SEQUENCE_TYPE, payload: Object.freeze({ sourceId: source.id, sha256: source.sha256, sequenceId, sequenceVersion: 1 }) }); }
  enqueueRequest(source, options = undefined) {
    checkedSource(source);
    if (options !== undefined) return this.enqueueOcrRequest(source, options);
    return Object.freeze({
      type: AUTOMATION_INSPECT_TYPE,
      payload: Object.freeze({ sourceId: source.id, sha256: source.sha256 }),
    });
  }

  enqueueOcrRequest(source, options = {}) {
    checkedSource(source);
    const normalized = normalizedOcrOptions(options);
    return Object.freeze({
      type: AUTOMATION_OCR_TYPE,
      payload: Object.freeze({
        sourceId: source.id, sha256: source.sha256,
        language: normalized.language, cleanupPreset: normalized.cleanupPreset,
        segmentation: normalized.segmentation, userDictionary: normalized.userDictionary,
      }),
    });
  }

  enqueueOutputIntentRequest(source) {
    checkedSource(source);
    return Object.freeze({
      type: AUTOMATION_OUTPUT_INTENT_TYPE,
      payload: Object.freeze({
        sourceId: source.id, sha256: source.sha256, profile: OUTPUT_INTENT_PROFILE,
      }),
    });
  }

  enqueuePresetRequest(source, preset) {
    checkedSource(source);
    const descriptor = automationPresetDescriptor(preset);
    return Object.freeze({
      type: descriptor.type,
      payload: Object.freeze({ preset: descriptor.id, sourceId: source.id, sha256: source.sha256 }),
    });
  }

  enqueueFullPageRedactionRequest(source, options = {}) {
    checkedSource(source);
    if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || Object.keys(options).some((key) => key !== 'pages')) {
      invalidOperation('Automation full-page redaction options are invalid.');
    }
    const normalized = fullPageRedactionPayload({
      sourceId: source.id, sha256: source.sha256, pages: options.pages,
    });
    return Object.freeze({
      type: AUTOMATION_FULL_PAGE_REDACTION_TYPE,
      payload: Object.freeze({
        sourceId: normalized.sourceId, sha256: normalized.sha256, pages: normalized.pages,
      }),
    });
  }

  async execute(type, payload, dependencies = {}) {
    if (type === AUTOMATION_SEQUENCE_TYPE) return this.#executeSequence(payload, dependencies);
    checkedExecution(type, dependencies);
    const {
      sources,
      store,
      service,
      fullPageRedaction,
      outputIntentService,
      signal,
    } = dependencies;
    const request = operationRequest(type, payload);
    const preset = requestedPreset(payload);
    const source = await sources.openVerified(request.sourceId, request.sha256);
    let document = null;
    let pendingOutput = null;
    let createdSources = [];
    try {
      document = await store.createDocument({
        stream: abortableSource(source.stream, signal),
        displayName: 'automation-source.pdf', mediaType: 'application/pdf',
      });
      createdSources.push(document);
      if (document.sha256 !== source.sha256 || document.size !== source.size) {
        throw new HostError(
          'AUTOMATION_SOURCE_MISMATCH', 'Automation source changed while it was rehydrated.', 409,
        );
      }
      if (type === AUTOMATION_INSPECT_TYPE) {
        return receiptWithPreset(
          inspectionReceipt(source, await service.inspect(document.id, { signal })), preset,
        );
      }
      let derived;
      if (type === AUTOMATION_FULL_PAGE_REDACTION_TYPE) {
        derived = await executeFullPageRedaction({
          source, request, store, fullPageRedaction, signal, sourceDocument: document,
        });
        createdSources = derived.created;
      } else {
        derived = await executeDerived(type, {
          source, request, document, sources, store, service, outputIntentService, signal,
        });
      }
      pendingOutput = await sources.stagePromotedArtifact({
        store, artifactId: derived.checked.artifact.id, source, signal,
      });
      const receipt = type === AUTOMATION_OUTPUT_INTENT_TYPE
        ? derived.receipt(source, derived.checked, pendingOutput)
        : type === AUTOMATION_FULL_PAGE_REDACTION_TYPE
          ? fullPageRedactionReceipt(source, derived.pages, derived.checked, pendingOutput)
          : derived.receipt(derived.checked, pendingOutput);
      return Object.freeze({ receipt: receiptWithPreset(receipt, preset), pendingOutput });
    } catch (error) {
      if (pendingOutput) {
        try {
          await sources.discardCreatedOutput(pendingOutput);
          pendingOutput = null;
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Automation derived-output execution and durable-output cleanup failed.',
          );
        }
      }
      throw error;
    } finally {
      source.stream.destroy();
      if (createdSources.length === 0 && document) {
        createdSources.push(document);
      }
      if (createdSources.length) {
        try {
          await Promise.all(createdSources.map((entry) => store.deleteDocument(entry.id)));
        } catch (cleanupError) {
          if (pendingOutput) {
            try {
              await sources.discardCreatedOutput(pendingOutput);
              pendingOutput = null;
            } catch (outputCleanupError) {
              throw new AggregateError(
                [cleanupError, outputCleanupError],
                'Transient automation cleanup and durable-output rollback failed.',
              );
            }
          }
          throw cleanupError;
        }
      }
    }
  }

  async #executeSequence(payload, dependencies) {
    return executeAutomationSequence({
      payload,
      dependencies,
      validate: checkedExecution,
      execute: (type, request, context) => this.execute(type, request, context),
    });
  }
}
