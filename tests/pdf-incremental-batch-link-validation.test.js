import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIncrementalBatchLinkProof } from '../scripts/host/pdf-incremental-batch-link-validation.mjs';

const rect = Object.freeze({ left: 10, bottom: 10, right: 30, top: 30 });
const request = Object.freeze({
  profile: 'local-aec-batch-link-v1',
  links: Object.freeze([{ sourcePage: 1, targetPage: 1, rect }]),
});

function validProof() {
  return {
    profile: request.profile,
    sourceBytes: 100,
    outputBytes: 200,
    appendedBytes: 100,
    sourcePrefixPreserved: true,
    revisionCount: 2,
    previousXrefOffset: 50,
    appendedXrefOffset: 100,
    links: [{
      sourcePage: 1,
      targetPage: 1,
      rect,
      sourcePageObjectNumber: 1,
      targetPageObjectNumber: 2,
      linkAnnotationObjectNumber: 3,
    }],
    updatedPageObjectNumbers: [1],
    updatedObjectNumbers: [3],
    effectiveSize: 4,
    rootPreserved: true,
    infoPreserved: true,
    idPolicy: 'absent',
  };
}

test('batch-link proof validation does not trust a poisoned Array.prototype.every', () => {
  const proof = validProof();
  proof.profile = 'wrong-profile';
  const links = proof.links;
  const originalEvery = Array.prototype.every;
  Object.defineProperty(proof, 'links', {
    configurable: true,
    enumerable: true,
    get() {
      Array.prototype.every = () => true;
      return links;
    },
  });

  let caught;
  try {
    assertIncrementalBatchLinkProof(proof, 100, 200, request);
  } catch (error) {
    caught = error;
  } finally {
    Array.prototype.every = originalEvery;
  }

  assert.equal(caught?.name, 'HostError');
  assert.equal(caught?.code, 'INCREMENTAL_BATCH_LINK_OUTPUT_INVALID');
  assert.equal(caught?.message, 'The raw batch-link proof did not match the fixed append-only contract.');
  assert.equal(caught?.status, 502);
});
