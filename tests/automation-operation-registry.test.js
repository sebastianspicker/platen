import test from 'node:test';
import { AUTOMATION_FULL_PAGE_REDACTION_TYPE } from '../scripts/host/automation/automation-operation-contract.mjs';
import {
  assert, AutomationOperationRegistry, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE,
  Readable, fullPageRedactionOutput,
  inspection, ocrOutput,
} from './support/automation-execution-fixture.js';

const SOURCE = Object.freeze({
  id: 'source_1', sha256: 'a'.repeat(64), size: 12,
});

function traceableSource(trace) {
  const stream = Readable.from([Buffer.from('%PDF-1.7\n')]);
  const destroy = stream.destroy.bind(stream);
  stream.destroy = (...args) => {
    trace.push('stream.destroy');
    return destroy(...args);
  };
  return Object.freeze({ ...SOURCE, stream });
}

test('registry characterization matrix preserves validation and inspection cleanup ordering', async () => {
  const registry = new AutomationOperationRegistry();
  const invalidTrace = [];
  await assert.rejects(registry.execute('not-allowlisted', {}, {
    sources: { openVerified() { invalidTrace.push('open'); } },
  }), {
    code: 'INVALID_AUTOMATION_OPERATION',
    message: 'Automation operation is not allowlisted.',
  });
  assert.deepEqual(invalidTrace, []);

  const trace = [];
  const receipt = await registry.execute(AUTOMATION_INSPECT_TYPE, {
    sourceId: SOURCE.id, sha256: SOURCE.sha256,
  }, {
    sources: {
      async openVerified() { trace.push('open'); return traceableSource(trace); },
    },
    store: {
      async createDocument() {
        trace.push('create');
        return { id: 'document_1', sha256: SOURCE.sha256, size: SOURCE.size };
      },
      async deleteDocument(id) { trace.push(`delete:${id}`); },
    },
    service: {
      async inspect(id) { trace.push(`inspect:${id}`); return inspection; },
    },
  });

  assert.deepEqual(trace, [
    'open', 'create', 'inspect:document_1', 'stream.destroy', 'delete:document_1',
  ]);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    operation: AUTOMATION_INSPECT_TYPE,
    sourceSha256: SOURCE.sha256,
    sourceBytes: SOURCE.size,
    pageCount: 1,
    pdfVersion: '1.7',
    encrypted: false,
    tagged: false,
    optimized: false,
  });
  assert(Object.isFrozen(receipt));
});

test('registry deletes a rehydrated document when either source identity field changes', async () => {
  const registry = new AutomationOperationRegistry();
  const mismatches = [
    { label: 'digest', sha256: 'b'.repeat(64), size: SOURCE.size },
    { label: 'size', sha256: SOURCE.sha256, size: SOURCE.size + 1 },
  ];
  for (const mismatch of mismatches) {
    const trace = [];
    await assert.rejects(registry.execute(AUTOMATION_INSPECT_TYPE, {
      sourceId: SOURCE.id, sha256: SOURCE.sha256,
    }, {
      sources: {
        async openVerified() { trace.push('open'); return traceableSource(trace); },
      },
      store: {
        async createDocument() {
          trace.push('create');
          return { id: `document_${mismatch.label}`, ...mismatch };
        },
        async deleteDocument(id) { trace.push(`delete:${id}`); },
      },
      service: {
        async inspect() { trace.push('inspect'); throw new Error('inspection must not run'); },
      },
    }), {
      code: 'AUTOMATION_SOURCE_MISMATCH',
      message: 'Automation source changed while it was rehydrated.',
      status: 409,
    });

    assert.deepEqual(trace, [
      'open', 'create', 'stream.destroy', `delete:document_${mismatch.label}`,
    ]);
  }
});

test('registry characterization matrix rolls back staged outputs when transient cleanup fails', async () => {
  const registry = new AutomationOperationRegistry();
  const trace = [];
  const document = { id: 'document_1', sha256: SOURCE.sha256, size: SOURCE.size };
  const output = ocrOutput({ sourceSha256: SOURCE.sha256, documentId: document.id });
  const pendingOutput = Object.freeze({
    id: 'output_1', sha256: output.artifact.sha256, size: output.artifact.size,
    sourceId: SOURCE.id, sourceSha256: SOURCE.sha256,
  });

  await assert.rejects(registry.execute(AUTOMATION_OCR_TYPE, {
    sourceId: SOURCE.id,
    sha256: SOURCE.sha256,
    language: 'eng',
    cleanupPreset: 'document',
    segmentation: 'auto',
    userDictionary: [],
  }, {
    sources: {
      async openVerified() { trace.push('open'); return traceableSource(trace); },
      async stagePromotedArtifact({ artifactId }) {
        trace.push(`stage:${artifactId}`);
        return pendingOutput;
      },
      async discardCreatedOutput(value) { trace.push(`discard:${value.id}`); },
    },
    store: {
      async createDocument() { trace.push('create'); return document; },
      getArtifact() { throw new Error('OCR must not read the artifact'); },
      async deleteDocument(id) {
        trace.push(`delete:${id}`);
        throw new Error('transient cleanup failed');
      },
    },
    service: {
      async ocrDocument(id) {
        trace.push(`ocr:${id}`);
        return output;
      },
    },
  }), /transient cleanup failed/u);

  assert.deepEqual(trace, [
    'open', 'create', 'ocr:document_1',
    `stage:${output.artifact.id}`,
    'stream.destroy', 'delete:document_1', 'discard:output_1',
  ]);
});

test('registry keeps cleanup failure members and order when output rollback also fails', async () => {
  const registry = new AutomationOperationRegistry();
  const trace = [];
  const document = { id: 'document_1', sha256: SOURCE.sha256, size: SOURCE.size };
  const output = ocrOutput({ sourceSha256: SOURCE.sha256, documentId: document.id });
  const pendingOutput = Object.freeze({
    id: 'output_1', sha256: output.artifact.sha256, size: output.artifact.size,
    sourceId: SOURCE.id, sourceSha256: SOURCE.sha256,
  });
  const deletionError = new Error('transient cleanup failed');
  const outputCleanupError = new Error('durable output cleanup failed');

  await assert.rejects(registry.execute(AUTOMATION_OCR_TYPE, {
    sourceId: SOURCE.id,
    sha256: SOURCE.sha256,
    language: 'eng',
    cleanupPreset: 'document',
    segmentation: 'auto',
    userDictionary: [],
  }, {
    sources: {
      async openVerified() { trace.push('open'); return traceableSource(trace); },
      async stagePromotedArtifact({ artifactId }) {
        trace.push(`stage:${artifactId}`);
        return pendingOutput;
      },
      async discardCreatedOutput(value) {
        trace.push(`discard:${value.id}`);
        throw outputCleanupError;
      },
    },
    store: {
      async createDocument() { trace.push('create'); return document; },
      getArtifact() { throw new Error('OCR must not read the artifact'); },
      async deleteDocument(id) {
        trace.push(`delete:${id}`);
        throw deletionError;
      },
    },
    service: {
      async ocrDocument(id) {
        trace.push(`ocr:${id}`);
        return output;
      },
    },
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.message, 'Transient automation cleanup and durable-output rollback failed.');
    assert.deepEqual(error.errors, [deletionError, outputCleanupError]);
    return true;
  });

  assert.deepEqual(trace, [
    'open', 'create', 'ocr:document_1',
    `stage:${output.artifact.id}`,
    'stream.destroy', 'delete:document_1', 'discard:output_1',
  ]);
});

test('registry discards an invalid staged output once before cleanup preserves its later deletion error', async () => {
  const registry = new AutomationOperationRegistry();
  const trace = [];
  const document = { id: 'document_1', sha256: SOURCE.sha256, size: SOURCE.size };
  const output = ocrOutput({ sourceSha256: SOURCE.sha256, documentId: document.id });
  const pendingOutput = Object.freeze({
    id: 'output_1', sha256: 'e'.repeat(64), size: output.artifact.size,
    sourceId: SOURCE.id, sourceSha256: SOURCE.sha256,
  });

  await assert.rejects(registry.execute(AUTOMATION_OCR_TYPE, {
    sourceId: SOURCE.id,
    sha256: SOURCE.sha256,
    language: 'eng',
    cleanupPreset: 'document',
    segmentation: 'auto',
    userDictionary: [],
  }, {
    sources: {
      async openVerified() { trace.push('open'); return traceableSource(trace); },
      async stagePromotedArtifact({ artifactId }) {
        trace.push(`stage:${artifactId}`);
        return pendingOutput;
      },
      async discardCreatedOutput(value) { trace.push(`discard:${value.id}`); },
    },
    store: {
      async createDocument() { trace.push('create'); return document; },
      getArtifact() { throw new Error('OCR must not read the artifact'); },
      async deleteDocument(id) {
        trace.push(`delete:${id}`);
        throw new Error('transient cleanup failed');
      },
    },
    service: {
      async ocrDocument(id) {
        trace.push(`ocr:${id}`);
        return output;
      },
    },
  }), /transient cleanup failed/u);

  assert.deepEqual(trace, [
    'open', 'create', 'ocr:document_1',
    `stage:${output.artifact.id}`,
    'discard:output_1', 'stream.destroy', 'delete:document_1',
  ]);
});

test('registry selects redaction batch or single-page services without changing cleanup order', async () => {
  const cases = [
    { pages: [1], serviceName: 'update', outputPages: null },
    { pages: [1, 2], serviceName: 'updateBatch', outputPages: [1, 2] },
  ];
  for (const { pages, serviceName, outputPages } of cases) {
    const registry = new AutomationOperationRegistry();
    const trace = [];
    const document = { id: 'document_1', sha256: SOURCE.sha256, size: SOURCE.size };
    const artifactBytes = Buffer.alloc(96, pages.at(-1));
    const output = fullPageRedactionOutput({
      sourceSha256: SOURCE.sha256,
      documentId: document.id,
      page: pages.at(-1),
      artifactBytes,
      pages: outputPages,
    });
    const pendingOutput = Object.freeze({
      id: 'output_1', sha256: output.artifact.sha256, size: output.artifact.size,
      sourceId: SOURCE.id, sourceSha256: SOURCE.sha256,
    });

    const result = await registry.execute(AUTOMATION_FULL_PAGE_REDACTION_TYPE, {
      sourceId: SOURCE.id, sha256: SOURCE.sha256, pages,
    }, {
      sources: {
        async openVerified() { trace.push('open'); return traceableSource(trace); },
        async stagePromotedArtifact({ artifactId }) {
          trace.push(`stage:${artifactId}`);
          return pendingOutput;
        },
        async discardCreatedOutput() { throw new Error('unexpected output rollback'); },
      },
      store: {
        async createDocument() { trace.push('create'); return document; },
        getArtifact() { throw new Error('batch and single-page redaction must not read artifacts'); },
        async deleteDocument(id) { trace.push(`delete:${id}`); },
      },
      fullPageRedaction: {
        async update(id, request, options) {
          trace.push(`update:${id}`);
          assert.equal(serviceName, 'update');
          assert.deepEqual(request, {
            profile: 'local-object-full-page-redaction-v1', sourceSha256: SOURCE.sha256, page: 1,
          });
          assert.deepEqual(options, { sourceSha256: SOURCE.sha256, signal: undefined });
          return output;
        },
        async updateBatch(id, request, options) {
          trace.push(`updateBatch:${id}`);
          assert.equal(serviceName, 'updateBatch');
          assert.deepEqual(request, {
            profile: 'local-object-full-page-redaction-batch-v1', sourceSha256: SOURCE.sha256, pages,
          });
          assert.deepEqual(options, { sourceSha256: SOURCE.sha256, signal: undefined });
          return output;
        },
      },
      service: {},
    });

    assert.deepEqual(result.receipt.pages, pages);
    assert(Object.isFrozen(result.receipt));
    assert.deepEqual(trace, [
      'open', 'create', `${serviceName}:document_1`,
      `stage:${output.artifact.id}`,
      'stream.destroy', 'delete:document_1',
    ]);
  }
});
