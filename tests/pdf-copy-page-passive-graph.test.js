import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPassiveCopyGraph } from '../scripts/host/pdf-copy-page-passive-graph.mjs';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';
import {
  makeObjectStreamPdf,
  makeXrefStreamPdf,
} from './support/pdf-xref-stream-fixture.js';
import { makeIndirectLengthPdf } from './support/pdf-indirect-length-fixture.js';

function inspect(bytes, expectedPageCount = 1) {
  return inspectPassiveCopyGraph(bytes, { expectedPageCount });
}

test('passive copy graph admits exact bounded classic, xref-stream, and object-stream PDFs', () => {
  for (const bytes of [
    makeTextPdf('classic'),
    makeXrefStreamPdf({ xrefFilters: ['RunLengthDecode'] }),
    makeObjectStreamPdf({
      compressedCatalog: true,
      objectFilters: ['RunLengthDecode'],
      xrefFilters: ['ASCII85Decode', 'RunLengthDecode'],
    }),
    makeIndirectLengthPdf(),
  ]) {
    const result = inspect(bytes);
    assert.deepEqual(Object.keys(result), [
      'schema', 'version', 'pageCount', 'pageTreeNodeCount', 'objectCount',
      'revisionCount', 'xrefFlavor', 'outlinesPresent', 'optionalContentPresent',
      'annotationCount', 'actionCount',
    ]);
    assert.equal(result.schema, 'pdf-copy-page-passive-graph-v1');
    assert.equal(result.pageCount, 1);
    assert.equal(result.outlinesPresent, false);
    assert.equal(result.optionalContentPresent, false);
    assert.equal(result.annotationCount, 0);
    assert.equal(result.actionCount, 0);
  }
});

test('passive copy graph rejects outlines, optional content, annotations, and actions', () => {
  const rejected = [
    makeTextPdf('outline', { outlines: [{ title: 'Section', page: 1 }] }),
    makeXrefStreamPdf({ pageExtra: ' /Vendor << /Type /OCG >>' }),
    makeXrefStreamPdf({ pageExtra: ' /Annots []' }),
    makeXrefStreamPdf({
      pageExtra: ' /Vendor << /Type /Annot /Subtype /FreeText >>',
    }),
    makeXrefStreamPdf({
      pageExtra: ' /Vendor << /A << /S /Launch /F (local-tool.app) >> >>',
    }),
    makeXrefStreamPdf({
      pageExtra: ' /Vendor << /S /SetOCGState >>',
    }),
  ];
  for (const bytes of rejected) {
    assert.throws(() => inspect(bytes), {
      code: 'COPY_PAGE_SOURCE_UNSUPPORTED',
      status: 422,
    });
  }
});

test('passive copy graph fails closed on page-tree disagreement and malformed input', () => {
  const mismatchedCount = Buffer.from(
    makeXrefStreamPdf({ filtered: false }).toString('latin1')
      .replace('/Count 1', '/Count 2'),
    'latin1',
  );
  const cycle = Buffer.from(
    makeXrefStreamPdf({ filtered: false }).toString('latin1')
      .replace('/Kids [5 0 R]', '/Kids [4 0 R]'),
    'latin1',
  );
  for (const run of [
    () => inspect(makeMultiPagePdf(['one', 'two']), 1),
    () => inspect(mismatchedCount),
    () => inspect(cycle),
    () => inspect(makeTextPdf('truncated').subarray(0, 80)),
    () => inspect(makeTextPdf('invalid bound'), 101),
  ]) {
    assert.throws(run, { code: 'COPY_PAGE_SOURCE_UNSUPPORTED', status: 422 });
  }
});
