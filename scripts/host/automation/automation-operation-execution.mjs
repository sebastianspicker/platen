import { createReadStream } from 'node:fs';
import { HostError } from '../host-error.mjs';
import { OUTPUT_INTENT_PROFILE } from '../prepress/output-intent-contract.mjs';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE,
} from './automation-operation-contract.mjs';
import {
  fullPageRedactionReceipt,
  inspectionReceipt,
  ocrReceipt,
  outputIntentReceipt,
  validatedFullPageRedaction,
  validatedFullPageRedactionBatch,
  validatedOcrOutput,
  validatedOutputIntent,
} from './automation-operation-results.mjs';
import {
  FULL_PAGE_REDACTION_BATCH_PROFILE,
  FULL_PAGE_REDACTION_PROFILE,
} from '../../../src/core/pdf-full-page-redaction-contract.js';

async function* abortableSource(stream, signal) {
  for await (const chunk of stream) {
    if (signal?.aborted) {
      throw new HostError('JOB_CANCELLED', 'Automation operation was cancelled.', 499);
    }
    yield chunk;
  }
}

function isArtifactIdentity(artifact, checkedArtifact) {
  return !!artifact && artifact.id === checkedArtifact.id
    && artifact.documentId === checkedArtifact.documentId
    && artifact.sha256 === checkedArtifact.sha256
    && artifact.size === checkedArtifact.size
    && artifact.mediaType === 'application/pdf'
    && typeof artifact.filePath === 'string';
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
  if (!isArtifactIdentity(artifact, checkedArtifact)) {
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
  if (signal?.aborted) {
    throw new HostError('JOB_CANCELLED', 'Full-page redaction was cancelled.', 499);
  }
  return working;
}

function fullPageRedactionExecution(created, checked, pages) {
  return Object.freeze({ created, checked, pages });
}

async function executeFullPageRedactionBatch(context) {
  const {
    source, request, sourceDocument, fullPageRedaction, signal,
  } = context;
  if (typeof fullPageRedaction.updateBatch !== 'function') {
    throw new HostError(
      'AUTOMATION_FULL_PAGE_REDACTION_BATCH_UNAVAILABLE',
      'Automation full-page redaction batch service is unavailable.',
      503,
    );
  }
  const derived = await fullPageRedaction.updateBatch(sourceDocument.id, {
    profile: FULL_PAGE_REDACTION_BATCH_PROFILE,
    sourceSha256: source.sha256,
    pages: request.pages,
  }, { sourceSha256: source.sha256, signal });
  const checked = validatedFullPageRedactionBatch(
    source, derived, sourceDocument.id, source.sha256, request.pages,
  );
  return fullPageRedactionExecution([sourceDocument], checked, request.pages);
}

async function updateFullPageRedactionDocument({
  source, current, currentDigest, page, fullPageRedaction, signal,
}) {
  if (signal?.aborted) {
    throw new HostError('JOB_CANCELLED', 'Full-page redaction was cancelled.', 499);
  }
  const derived = await fullPageRedaction.update(current.id, {
    profile: FULL_PAGE_REDACTION_PROFILE,
    sourceSha256: currentDigest,
    page,
  }, { sourceSha256: currentDigest, signal });
  const checked = validatedFullPageRedaction(source, derived, current.id, currentDigest);
  if (checked.redaction.page !== page) {
    throw new HostError(
      'AUTOMATION_RESULT_INVALID',
      'Automation full-page redaction output was not bound to the requested page.',
      502,
    );
  }
  return checked;
}

async function chainFullPageRedactionDocument(store, checked, signal) {
  const document = await createWorkingDocumentFromArtifact(store, checked.artifact, signal);
  if (document.sha256 !== checked.artifact.sha256) {
    throw new HostError(
      'AUTOMATION_RESULT_INVALID',
      'Automation full-page redaction output changed while chaining.',
      502,
    );
  }
  return document;
}

async function executeSequentialFullPageRedaction(context) {
  const {
    source, request, sourceDocument, fullPageRedaction, signal,
  } = context;
  const created = [sourceDocument];
  let current = sourceDocument;
  let currentDigest = source.sha256;
  let finalChecked = null;
  for (const page of request.pages) {
    const checked = await updateFullPageRedactionDocument({
      source, current, currentDigest, page, fullPageRedaction, signal,
    });
    currentDigest = checked.sourceDigest;
    finalChecked = checked;
    if (page !== request.pages.at(-1)) {
      current = await chainFullPageRedactionDocument(context.store, checked, signal);
      created.push(current);
      currentDigest = current.sha256;
    }
  }
  return fullPageRedactionExecution(created, finalChecked, request.pages);
}

async function executeFullPageRedaction(context) {
  return context.request.pages.length > 1
    ? executeFullPageRedactionBatch(context)
    : executeSequentialFullPageRedaction(context);
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
    language: request.language,
    cleanupPreset: request.cleanupPreset,
    segmentation: request.segmentation,
    userDictionary: request.userDictionary,
    signal,
  });
  return Object.freeze({
    checked: validatedOcrOutput(source, request, output, document.id),
    receipt: (checked, pendingOutput) => ocrReceipt(source, request, checked, pendingOutput),
  });
}

export async function hydrateAutomationSource(store, source, signal, state) {
  const document = await store.createDocument({
    stream: abortableSource(source.stream, signal),
    displayName: 'automation-source.pdf',
    mediaType: 'application/pdf',
  });
  state.document = document;
  state.createdSources.push(document);
  if (document.sha256 !== source.sha256 || document.size !== source.size) {
    throw new HostError(
      'AUTOMATION_SOURCE_MISMATCH',
      'Automation source changed while it was rehydrated.',
      409,
    );
  }
  return document;
}

export async function dispatchAutomationOperation(type, context) {
  const {
    source, request, document, store, service, fullPageRedaction, outputIntentService, signal,
  } = context;
  if (type === AUTOMATION_INSPECT_TYPE) {
    return Object.freeze({
      receipt: inspectionReceipt(source, await service.inspect(document.id, { signal })),
      createdSources: null,
      derived: null,
    });
  }
  if (type === AUTOMATION_FULL_PAGE_REDACTION_TYPE) {
    const derived = await executeFullPageRedaction({
      source, request, store, fullPageRedaction, signal, sourceDocument: document,
    });
    return Object.freeze({ receipt: null, createdSources: derived.created, derived });
  }
  const derived = await executeDerived(type, context);
  return Object.freeze({ receipt: null, createdSources: null, derived });
}

export function createAutomationDerivedReceipt({
  type, source, derived, pendingOutput, preset,
}) {
  const receipt = type === AUTOMATION_OUTPUT_INTENT_TYPE
    ? derived.receipt(source, derived.checked, pendingOutput)
    : type === AUTOMATION_FULL_PAGE_REDACTION_TYPE
      ? fullPageRedactionReceipt(source, derived.pages, derived.checked, pendingOutput)
      : derived.receipt(derived.checked, pendingOutput);
  return preset ? Object.freeze({ ...receipt, preset }) : receipt;
}

async function discardPendingAutomationOutput(sources, state) {
  if (!state.pendingOutput) return;
  await sources.discardCreatedOutput(state.pendingOutput);
  state.pendingOutput = null;
}

export async function rollbackAutomationOutput(sources, state, error) {
  if (!state.pendingOutput) throw error;
  try {
    await discardPendingAutomationOutput(sources, state);
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      'Automation derived-output execution and durable-output cleanup failed.',
    );
  }
  throw error;
}

function createdAutomationSources(state) {
  if (state.createdSources.length === 0 && state.document) {
    state.createdSources.push(state.document);
  }
  return state.createdSources;
}

async function deleteAutomationSources(store, createdSources) {
  await Promise.all(createdSources.map((entry) => store.deleteDocument(entry.id)));
}

async function rollbackAfterSourceCleanupFailure(sources, state, cleanupError) {
  try {
    await discardPendingAutomationOutput(sources, state);
  } catch (outputCleanupError) {
    throw new AggregateError(
      [cleanupError, outputCleanupError],
      'Transient automation cleanup and durable-output rollback failed.',
    );
  }
  throw cleanupError;
}

export async function cleanupAutomationSources(source, state, store, sources) {
  source.stream.destroy();
  const createdSources = createdAutomationSources(state);
  if (!createdSources.length) return;
  try {
    await deleteAutomationSources(store, createdSources);
  } catch (cleanupError) {
    await rollbackAfterSourceCleanupFailure(sources, state, cleanupError);
  }
}
