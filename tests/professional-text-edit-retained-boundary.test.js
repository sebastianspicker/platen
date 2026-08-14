import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { inspectPdfTextEdit, writePdfTextEdit } from '../scripts/host/pdf-text-edit-writer.mjs';
import { PDF_TEXT_EDIT_PROFILE } from '../scripts/host/pdf-text-edit-contract.mjs';
import { textEditWithRetainedBoundary } from '../scripts/host/professional-capability/text-edit-retained-boundary.mjs';
import { digest } from '../scripts/host/professional-capability/fixtures.mjs';
import { makeTextPdf } from './pdf-fixture.js';
import { opEditText } from '../scripts/host/professional-capability/real-ops-content.mjs';
import { handlers } from '../scripts/host/professional-capability/content-editing.mjs';

const documentId = '22222222-2222-4222-8222-222222222222';

function makeTextEditRequest(source, find = 'hello world', replace = 'HELLO WORLD') {
  const sourceSha256 = digest(source);
  const request = Object.freeze({
    profile: PDF_TEXT_EDIT_PROFILE,
    sourceSha256,
    page: 1,
    find,
    replace,
  });
  const output = writePdfTextEdit(source, request).bytes;
  return {
    source,
    sourceSha256,
    request,
    output,
    outputSha256: createHash('sha256').update(output).digest('hex'),
  };
}

function makeArtifact(documentId, sourceSha256, output) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    documentId,
    mediaType: 'application/pdf',
    size: output.length,
    sha256: createHash('sha256').update(output).digest('hex'),
    operation: {
      type: 'pdf-text-edit',
      inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
      parameters: {
        profile: PDF_TEXT_EDIT_PROFILE,
        page: 1,
        findSha256: createHash('sha256').update(Buffer.from('hello world', 'latin1')).digest('hex'),
        replaceSha256: createHash('sha256').update(Buffer.from('HELLO WORLD', 'latin1')).digest('hex'),
      },
      validation: {
        passed: true,
        outputSha256: createHash('sha256').update(output).digest('hex'),
      },
    },
  };
}

function makeReceipt(documentId, source, output) {
  const { request, sourceSha256 } = makeTextEditRequest(source);
  return {
    kind: 'pdf-text-edit',
    proof: inspectPdfTextEdit(source, output, request),
    artifact: makeArtifact(documentId, sourceSha256, output),
    limitations: ['One exact equal-length replacement'],
  };
}

function productionContext(overrides = {}) {
  const source = makeTextPdf('hello world');
  const { request, output, sourceSha256 } = makeTextEditRequest(source);
  const artifact = makeArtifact(documentId, sourceSha256, output);
  const receipt = makeReceipt(documentId, source, output);
  const calls = Object.freeze({
    called: {
      edit: 0,
      findReplace: 0,
      readArtifact: 0,
      deleteArtifact: 0,
    },
  });
  const service = {
    async edit(targetId, targetRequest, { signal } = {}) {
      calls.called.edit += 1;
      assert.equal(targetId, documentId);
      assert.equal(targetRequest.profile, PDF_TEXT_EDIT_PROFILE);
      assert.equal(targetRequest.sourceSha256, sourceSha256);
      if (typeof overrides.edit === 'function') {
        return overrides.edit({ targetId, targetRequest, signal, sourceSha256, source, artifact, receipt, documentId, output });
      }
      return overrides.receipt ?? receipt;
    },
    async findReplace(targetId, targetRequest, { signal } = {}) {
      calls.called.findReplace += 1;
      assert.equal(targetId, documentId);
      assert.equal(targetRequest.profile, PDF_TEXT_EDIT_PROFILE);
      assert.equal(targetRequest.sourceSha256, sourceSha256);
      if (typeof overrides.findReplace === 'function') {
        return overrides.findReplace({ targetId, targetRequest, signal, sourceSha256, source, artifact, receipt, documentId, output });
      }
      return overrides.receipt ?? receipt;
    },
  };
  return {
    source,
    request,
    sourceSha256,
    output,
    artifact,
    receipt,
    calls: calls.called,
    context: {
      ...overrides,
      sourcePdf: source,
      sourceSha256,
      documentId,
      capabilityId: overrides.capabilityId,
      textEdit: service,
      readArtifact: async (actualArtifact) => {
        calls.called.readArtifact += 1;
        if (overrides.readArtifact) return overrides.readArtifact(actualArtifact);
        assert.deepEqual(actualArtifact, artifact);
        return output;
      },
      store: {
        async deleteArtifact(id) {
          calls.called.deleteArtifact += 1;
          if (overrides.deleteFailure) throw new Error('delete failed');
        },
      },
    },
  };
}

for (const capabilityId of ['edit.text', 'edit.find-replace']) {
  test(`edit.text-style production boundary succeeds for ${capabilityId}`, async () => {
    const context = productionContext({ capabilityId });
    const result = await opEditText(context.context);
    assert.equal(result.method, 'production-pdf-text-edit-service');
    assert.equal(result.localOnly, true);
    assert.equal(result.retainedBoundaryValidated, true);
    assert.equal(result.outputSha256, context.receipt.artifact.sha256);
    assert.equal(result.sourceSha256, context.sourceSha256);
    assert.equal(result.trustBoundary.productionService, true);
    assert.equal(result.trustBoundary.artifactReread, true);
    assert.equal(result.trustBoundary.independentSemanticInspection, true);
    assert.equal(result.trustBoundary.immutableSourceDigest, true);
    assert.equal(result.pdf.equals(context.output), true);
    assert.deepEqual(result.artifact, context.receipt.artifact);
    if (capabilityId === 'edit.text') {
      assert.equal(context.calls.edit, 1);
      assert.equal(context.calls.findReplace, 0);
    } else {
      assert.equal(context.calls.findReplace, 1);
      assert.equal(context.calls.edit, 0);
    }
    assert.equal(context.calls.readArtifact, 1);
  });
}

test('edit.find-replace facade awaits and preserves the retained production result', async () => {
  const context = productionContext({ capabilityId: 'edit.find-replace' });
  const result = await handlers['edit.find-replace'](context.context);
  assert.equal(result.capabilityId, 'edit.find-replace');
  assert.equal(result.method, 'production-pdf-text-edit-service');
  assert.equal(result.retainedBoundaryValidated, true);
  assert.equal(result.outputSha256, context.receipt.artifact.sha256);
  assert.equal(context.calls.findReplace, 1);
  assert.equal(context.calls.edit, 0);
});

test('edit.find-replace direct retained boundary preserves identity and dispatches findReplace', async () => {
  const context = productionContext({ capabilityId: 'edit.find-replace' });
  const result = await textEditWithRetainedBoundary(context.context);
  assert.equal(result.capabilityId, 'edit.find-replace');
  assert.equal(result.method, 'production-pdf-text-edit-service');
  assert.equal(result.retainedBoundaryValidated, true);
  assert.equal(result.outputSha256, context.receipt.artifact.sha256);
  assert.equal(context.calls.findReplace, 1);
  assert.equal(context.calls.edit, 0);
  assert.equal(context.calls.readArtifact, 1);
});

test('local text edit derives its default source from a caller-supplied search term', async () => {
  const result = await opEditText({ find: 'custom term', replace: 'CUSTOM TERM' });
  assert.equal(result.find, 'custom term');
  assert.equal(result.replace, 'CUSTOM TERM');
  assert.equal(result.replacementCount, 1);
});

test('text edit local fallback exposes nonPromotable for local mode', async () => {
  const result = await opEditText({ find: 'custom term', replace: 'CUSTOM TERM' });
  assert.equal(result.nonPromotable, true);
});

test('edit.find-replace local retained boundary preserves capability identity', async () => {
  const result = await opEditText({ capabilityId: 'edit.find-replace', find: 'custom term', replace: 'CUSTOM TERM' });
  assert.equal(result.capabilityId, 'edit.find-replace');
  assert.equal(result.method, 'local-pdf-text-edit-writer');
  assert.equal(result.nonPromotable, true);
  assert.equal(result.replacementCount, 1);
});

test('text edit production boundary rejects stale source digest for both ids', async () => {
  for (const capabilityId of ['edit.text', 'edit.find-replace']) {
    const context = productionContext({ capabilityId });
    await assert.rejects(opEditText({
      ...context.context,
      sourceSha256: '0'.repeat(64),
      capabilityId,
    }), {
      code: 'SOURCE_VERSION_MISMATCH',
      status: 409,
    });
  }
});

test('text edit production boundary rejects malformed document ids', async () => {
  for (const capabilityId of ['edit.text', 'edit.find-replace']) {
    const context = productionContext({ capabilityId });
    await assert.rejects(opEditText({
      ...context.context,
      documentId: 'not-a-uuid',
      capabilityId,
    }), {
      code: 'TEXT_EDIT_DOCUMENT_REQUIRED',
      status: 400,
    });
  }
});

test('text edit production boundary rejects forged provenance and receipt', async () => {
  for (const capabilityId of ['edit.text', 'edit.find-replace']) {
    const context = productionContext({ capabilityId });
    const forgedArtifact = {
      ...context.receipt.artifact,
      documentId: '00000000-0000-4000-8000-000000000000',
      sha256: '0'.repeat(64),
    };
    const forged = {
      ...context.receipt,
      artifact: {
        ...forgedArtifact,
        operation: {
          ...context.receipt.artifact.operation,
          type: 'pdf-hidden-data-sanitization',
        },
      },
    };
    const forgedContext = productionContext({
      capabilityId,
      receipt: forged,
      readArtifact: async () => {
        return context.output;
      },
    });
    await assert.rejects(opEditText(forgedContext.context), { code: 'TEXT_EDIT_RECEIPT_INVALID' });
  }
});

test('text edit production marker prevents local fallback when document id is present but no production service', async () => {
  for (const capabilityId of ['edit.text', 'edit.find-replace']) {
    const context = productionContext({ capabilityId });
    await assert.rejects(opEditText({
      ...context.context,
      textEdit: undefined,
      pdfTextEdit: undefined,
      capabilityId,
    }), {
      code: 'TEXT_EDIT_SERVICE_UNAVAILABLE',
      status: 503,
    });
    assert.equal(context.calls.edit, 0);
    assert.equal(context.calls.findReplace, 0);
    assert.equal(context.calls.readArtifact, 0);
    assert.equal(context.calls.deleteArtifact, 0);
  }
});

test('text edit production marker prevents local fallback when readArtifact exists without service', async () => {
  const context = productionContext({
    capabilityId: 'edit.text',
    readArtifact: async () => context.output,
  });
  await assert.rejects(opEditText({
    ...context.context,
    textEdit: undefined,
    pdfTextEdit: undefined,
    capabilityId: 'edit.text',
  }), {
    code: 'TEXT_EDIT_SERVICE_UNAVAILABLE',
    status: 503,
  });
  assert.equal(context.calls.readArtifact, 0);
  assert.equal(context.calls.deleteArtifact, 0);
});

test('text edit production boundary normalizes malformed reread bytes to reread-failed', async () => {
  const context = productionContext({
    capabilityId: 'edit.text',
    readArtifact: async () => 'not-pdf-bytes',
  });
  let error;
  try {
    await opEditText(context.context);
    assert.fail('Expected reread-failed error.');
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, 'TEXT_EDIT_ARTIFACT_READBACK_FAILED');
  assert.equal(error?.status, 502);
  assert.equal(error.cause?.code, 'INVALID_PROFESSIONAL_INPUT');
});

test('text edit production boundary cancels with cleanup after service promotion', async () => {
  const controller = new AbortController();
  const context = productionContext({
    capabilityId: 'edit.text',
    edit: ({ targetId, targetRequest, sourceSha256 }) => {
      assert.equal(targetId, documentId);
      assert.equal(targetRequest.sourceSha256, sourceSha256);
      controller.abort(new Error('cancelled after service promotion'));
      return context.receipt;
    },
  });
  await assert.rejects(opEditText({
    ...context.context,
    signal: controller.signal,
    capabilityId: 'edit.text',
  }), {
    code: 'JOB_CANCELLED',
    status: 499,
  });
  assert.equal(context.calls.edit, 1);
  assert.equal(context.calls.readArtifact, 0);
  assert.equal(context.calls.deleteArtifact, 1);
});

test('text edit production boundary cancels with cleanup during reread', async () => {
  const controller = new AbortController();
  const context = productionContext({
    capabilityId: 'edit.text',
    readArtifact: async () => {
      controller.abort(new Error('cancelled during reread'));
      return context.output;
    },
  });
  await assert.rejects(opEditText({
    ...context.context,
    signal: controller.signal,
    capabilityId: 'edit.text',
  }), {
    code: 'JOB_CANCELLED',
    status: 499,
  });
  assert.equal(context.calls.readArtifact, 1);
  assert.equal(context.calls.deleteArtifact, 1);
});

for (const capabilityId of ['edit.text', 'edit.find-replace']) {
  test(`text edit production boundary propagates cancellation for ${capabilityId}`, async () => {
    const context = productionContext({ capabilityId });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(opEditText({
      ...context.context,
      signal: controller.signal,
      capabilityId,
    }), { code: 'JOB_CANCELLED', status: 499 });
    if (capabilityId === 'edit.text') {
      assert.equal(context.calls.edit, 0);
    } else {
      assert.equal(context.calls.findReplace, 0);
    }
  });
}

test('text edit production boundary propagates cleanup failure on hostile reread', async () => {
  const context = productionContext({
    capabilityId: 'edit.text',
    readArtifact: async () => {
      return Buffer.from('tampered-bytes');
    },
    deleteFailure: true,
  });
  let error;
  try {
    await opEditText(context.context);
    assert.fail('Expected cleanup failure error.');
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, 'TEXT_EDIT_CLEANUP_FAILED');
  assert.equal(context.calls.deleteArtifact, 1);
  assert.equal(error.cause instanceof AggregateError, true);
});
