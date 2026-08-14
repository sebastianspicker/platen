import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparisonCsv,
  createComparisonWorkflowController,
} from '../src/controllers/comparison-workflow-controller.js';
import { spreadsheetSafeCsvCell } from '../src/core/spreadsheet-safe-csv.js';

test('shared CSV cell encoding neutralizes every spreadsheet formula prefix', () => {
  for (const value of ['=1+1', '+cmd', '-1', '@sum', '  =hidden', '\tplain', '\rplain', '\nplain']) {
    assert.match(spreadsheetSafeCsvCell(value), /^"'/u);
  }
  assert.equal(spreadsheetSafeCsvCell('A "quoted", value'), '"A ""quoted"", value"');
  assert.equal(spreadsheetSafeCsvCell('plain'), '"plain"');
});

test('comparison CSV is formula-safe quoted output over bounded report fields', () => {
  assert.equal(comparisonCsv({
    kind: 'content',
    inputs: [
      { role: 'primary', sha256: 'a'.repeat(64) },
      { role: 'secondary', sha256: 'b'.repeat(64) },
    ],
    pages: [{ page: 1, status: '  =changed', stats: { added: 2, deleted: 1, unchanged: 3 } }],
  }), [
    '"primarySha256","secondarySha256","kind","page","status","added","deleted","unchanged","changedPixels","comparedPixels"',
    `"${'a'.repeat(64)}","${'b'.repeat(64)}","content","1","'  =changed","2","1","3","",""`,
    '',
  ].join('\n'));
});

test('comparison controller stages one secondary source, records the report, cleans it, and exports', async () => {
  const calls = [];
  const downloads = [];
  const picker = { value: 'selected' };
  const state = {
    analysis: { documentId: 'primary' },
    selectedPage: 3,
    comparisonMode: 'pixel',
    comparisonReport: null,
    comparisonFileName: null,
    busyAction: null,
    error: null,
    document: { name: 'primary.pdf' },
  };
  const operation = { documentId: 'primary', controller: new AbortController() };
  const controller = createComparisonWorkflowController({
    state,
    client: {
      async upload(file) { calls.push(['upload', file.name]); return { id: 'secondary' }; },
      async compareDocuments(primary, secondary, mode, options) {
        calls.push(['compare', primary, secondary, mode, options]);
        return {
          kind: 'pixel',
          inputs: [
            { role: 'primary', sha256: 'a'.repeat(64) },
            { role: 'secondary', sha256: 'b'.repeat(64) },
          ],
          pages: [{ page: 3, changedPixels: 1, comparedPixels: 10 }],
        };
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => assert.fail(error.message),
    finishOperation: () => { state.busyAction = null; },
    removeHostDocument: async (id) => calls.push(['remove', id]),
    triggerDownload: (download) => downloads.push(download),
    render: () => {},
    announce: (message) => calls.push(['announce', message]),
    document: { querySelector: () => picker },
  });

  await controller.compareWithFile({ name: 'secondary.pdf' });
  assert.equal(state.comparisonReport.kind, 'pixel');
  assert.equal(state.comparisonFileName, 'secondary.pdf');
  assert.equal(calls.find(([name]) => name === 'compare')[4].pages[0], 3);
  assert.deepEqual(calls.find(([name]) => name === 'remove'), ['remove', 'secondary']);
  assert.equal(picker.value, '');

  controller.exportComparison('csv');
  assert.equal(downloads[0].fileName, 'primary-comparison.csv');
  assert.equal(downloads[0].blob.type, 'text/csv;charset=utf-8');
});
