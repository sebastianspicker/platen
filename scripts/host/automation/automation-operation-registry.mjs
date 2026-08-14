import { OUTPUT_INTENT_PROFILE } from '../prepress/output-intent-contract.mjs';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE, AUTOMATION_OUTPUT_INTENT_TYPE,
  automationPresetDescriptor, expandAutomationPreset, fullPageRedactionPayload,
  invalidOperation, normalizedOcrOptions, OPAQUE_ID, ocrPayload, outputIntentPayload,
  presetPayload,
  SHA256, sourcePayload,
} from './automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_TYPE, automationSequenceDescriptor } from './automation-sequence-contract.mjs';
import { executeAutomationSequence } from './automation-sequence-execution.mjs';
import {
  cleanupAutomationSources,
  createAutomationDerivedReceipt,
  dispatchAutomationOperation,
  hydrateAutomationSource,
  rollbackAutomationOutput,
} from './automation-operation-execution.mjs';

export {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE, AUTOMATION_OUTPUT_INTENT_TYPE,
  AUTOMATION_INSPECT_PRESET, AUTOMATION_OCR_PRESET, AUTOMATION_OUTPUT_INTENT_PRESET,
  AUTOMATION_PRESET_IDS, AUTOMATION_PRESET_SCHEMA_VERSION,
} from './automation-operation-contract.mjs';
export { AUTOMATION_SEQUENCE_TYPE, AUTOMATION_SEQUENCE_IDS, automationSequenceDescriptor } from './automation-sequence-contract.mjs';

function allowlistedOperation(type) {
  return [
    AUTOMATION_INSPECT_TYPE,
    AUTOMATION_OCR_TYPE,
    AUTOMATION_OUTPUT_INTENT_TYPE,
    AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  ].includes(type);
}

function hasSourceDocumentDependencies({ sources, store, service }) {
  return !!sources && !!store && !!service && typeof sources.openVerified === 'function'
    && typeof store.createDocument === 'function' && typeof store.deleteDocument === 'function';
}

function hasInspectionDependencies({ service }) {
  return typeof service.inspect === 'function';
}

function hasOcrDependencies({ sources, store, service }) {
  return typeof service.ocrDocument === 'function'
    && typeof sources.stagePromotedArtifact === 'function'
    && typeof sources.discardCreatedOutput === 'function'
    && typeof store.getArtifact === 'function';
}

function hasOutputIntentDependencies({ sources, store, outputIntentService }) {
  return typeof outputIntentService?.assign === 'function'
    && typeof sources.stagePromotedArtifact === 'function'
    && typeof sources.discardCreatedOutput === 'function'
    && typeof store.getArtifact === 'function';
}

function hasFullPageRedactionDependencies({ sources, store, fullPageRedaction }) {
  return typeof fullPageRedaction?.update === 'function'
    && typeof sources.stagePromotedArtifact === 'function'
    && typeof sources.discardCreatedOutput === 'function'
    && typeof store.createDocument === 'function'
    && typeof store.getArtifact === 'function';
}

function hasOperationDependencies(type, dependencies) {
  if (type === AUTOMATION_INSPECT_TYPE) return hasInspectionDependencies(dependencies);
  if (type === AUTOMATION_OCR_TYPE) return hasOcrDependencies(dependencies);
  if (type === AUTOMATION_OUTPUT_INTENT_TYPE) return hasOutputIntentDependencies(dependencies);
  return hasFullPageRedactionDependencies(dependencies);
}

function checkedExecution(type, dependencies) {
  const {
    sources, store, service, fullPageRedaction, outputIntentService,
  } = dependencies;
  const execution = { sources, store, service, fullPageRedaction, outputIntentService };
  if (!allowlistedOperation(type)) {
    invalidOperation('Automation operation is not allowlisted.');
  }
  if (!hasSourceDocumentDependencies(execution) || !hasOperationDependencies(type, execution)) {
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
    const state = { document: null, pendingOutput: null, createdSources: [] };
    try {
      await hydrateAutomationSource(store, source, signal, state);
      const dispatched = await dispatchAutomationOperation(type, {
        source, request, document: state.document, store, service, fullPageRedaction,
        outputIntentService, signal,
      });
      if (dispatched.receipt) return receiptWithPreset(dispatched.receipt, preset);
      if (dispatched.createdSources) state.createdSources = dispatched.createdSources;
      state.pendingOutput = await sources.stagePromotedArtifact({
        store, artifactId: dispatched.derived.checked.artifact.id, source, signal,
      });
      const receipt = createAutomationDerivedReceipt({
        type, source, derived: dispatched.derived, pendingOutput: state.pendingOutput, preset,
      });
      return Object.freeze({ receipt, pendingOutput: state.pendingOutput });
    } catch (error) {
      await rollbackAutomationOutput(sources, state, error);
    } finally {
      await cleanupAutomationSources(source, state, store, sources);
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
