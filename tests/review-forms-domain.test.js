import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { ReviewFormsDomain } from '../scripts/host/domains/review-forms.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
function setup() { let n = 0; const store = new WorkspaceStateStore((id) => id === documentId); return { store, domain: new ReviewFormsDomain(store, { clock: () => '2026-07-18T12:00:00.000Z', idFactory: (prefix) => `${prefix}-${++n}` }) }; }

test('review sidecar supports annotation types, replies, status, query, tracking, and safe exports', () => {
  const { domain, store } = setup();
  let state = domain.createAnnotation(documentId, { type: 'comment', page: 1, rectangle: [1, 2, 3, 4], text: 'Need <review>', author: 'Ada', mentions: ['Lin'] });
  state = domain.reply(documentId, 'annotation-1', { text: 'Acknowledged', author: 'Lin' }, { expectedRevision: state.revision });
  state = domain.updateAnnotation(documentId, 'annotation-1', { status: 'custom', customStatus: 'needs & legal', properties: { color: 'yellow' } }, { expectedRevision: state.revision });
  state = domain.setReviewState(documentId, { participants: ['Ada', 'Lin'], dueDate: '2026-08-01', tracking: 'round one' }, { expectedRevision: state.revision });
  assert.equal(store.snapshot(documentId).namespaces.annotations[0].prototypeSidecar, true);
  assert.equal(domain.queryAnnotations(documentId, { search: 'review' })[0].replies.length, 1);
  const summary = domain.reviewSummary(documentId);
  assert.match(summary.xfdf, /Need &lt;review&gt;/); assert.match(summary.csv, /Need <review>/);
  assert.equal(domain.exportReviewJson(documentId).note.includes('not embedded'), true);
  assert.throws(() => domain.createAnnotation(documentId, { type: 'evil', page: 1, rectangle: [0, 0, 1, 1] }), { code: 'INVALID_ANNOTATION_TYPE' });
  assert.throws(() => domain.updateAnnotation(documentId, 'annotation-1', { status: 'open' }, { expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
});

test('review import is bounded and XFA/PDF flattening are explicit unsupported operations', () => {
  const { domain } = setup();
  assert.throws(() => domain.importReviewJson(documentId, { format: 'bad', annotations: [] }), { code: 'INVALID_INTERCHANGE' });
  assert.equal(domain.unsupportedXfa().supported, false); assert.equal(domain.unsupportedFlattening().code, 'PDF_FLATTENING_UNSUPPORTED');
});

test('forms validate bounded definitions, values, controlled calculations, submissions, and interchange', () => {
  const { domain } = setup();
  let state = domain.createField(documentId, { id: 'qty', name: 'qty', type: 'number', page: 1, rectangle: [0, 0, 10, 10], required: true, validation: { min: 1, max: 10 } });
  state = domain.createField(documentId, { id: 'price', name: 'price', type: 'number', page: 1, rectangle: [11, 0, 20, 10] }, { expectedRevision: state.revision });
  state = domain.createField(documentId, { id: 'total', name: 'total', type: 'number', page: 1, rectangle: [21, 0, 30, 10], calculation: 'product(qty,price)' }, { expectedRevision: state.revision });
  state = domain.setValue(documentId, 'qty', 2, { expectedRevision: state.revision });
  state = domain.setValue(documentId, 'price', 3, { expectedRevision: state.revision });
  assert.deepEqual(domain.validate(documentId), []);
  assert.equal(domain.exportForms(documentId).values.find((v) => v.id === 'total').value, 6);
  state = domain.submitResponse(documentId, { expectedRevision: state.revision });
  assert.equal(state.namespaces.workflowRecords[0].kind, 'formResponse');
  assert.match(domain.exportForms(documentId).csv, /fieldId,name,value/);
  assert.throws(() => domain.createField(documentId, { name: 'bad', type: 'text', page: 1, rectangle: [0, 0, 1, 1], validation: { pattern: '(a+)+!' } }, { expectedRevision: state.revision }), { code: 'UNSAFE_PATTERN' });
  assert.throws(() => domain.createField(documentId, { name: 'bad2', type: 'text', page: 1, rectangle: [0, 0, 1, 1], calculation: 'eval(qty)' }, { expectedRevision: state.revision }), { code: 'INVALID_CALCULATION' });
});

test('form detection and static conversion are deterministic', () => {
  const { domain } = setup();
  const candidates = domain.detectFields('Full Name*\nOrder Amount\nI agree');
  assert.deepEqual(candidates.map((f) => f.type), ['text', 'number', 'checkbox']);
  const state = domain.staticToFillable(documentId, candidates);
  assert.equal(state.namespaces.formFields.length, 3);
});

test('review-form patterns keep the simple persisted subset and reject nested repetition', () => {
  const { domain } = setup();
  let state = domain.createField(documentId, {
    id: 'postal', name: 'postal', type: 'text', page: 1, rectangle: [0, 0, 1, 1], validation: { pattern: '\\d\\d' },
  });
  state = domain.setValue(documentId, 'postal', '12', { expectedRevision: state.revision });
  assert.deepEqual(domain.validate(documentId), []);
  state = domain.setValue(documentId, 'postal', 'x', { expectedRevision: state.revision });
  assert.deepEqual(domain.validate(documentId), [{ fieldId: 'postal', code: 'pattern' }]);
  assert.throws(() => domain.createField(documentId, {
    name: 'redos', type: 'text', page: 1, rectangle: [0, 0, 1, 1], validation: { pattern: '(a+)+$' },
  }, { expectedRevision: state.revision }), { code: 'UNSAFE_PATTERN' });
});

test('review and form CSV exports neutralize spreadsheet formula values', () => {
  const { domain } = setup();
  let state = domain.createAnnotation(documentId, {
    type: 'comment', page: 1, rectangle: [0, 0, 1, 1], text: '=CMD()', author: '@operator',
  });
  assert.match(domain.reviewSummary(documentId).csv, /'=CMD\(\)/u);
  state = domain.createField(documentId, {
    id: 'note', name: 'note', type: 'text', page: 1, rectangle: [0, 0, 1, 1],
  }, { expectedRevision: state.revision });
  domain.setValue(documentId, 'note', '  +SUM(A1:A2)', { expectedRevision: state.revision });
  assert.match(domain.exportForms(documentId).csv, /'  \+SUM\(A1:A2\)/u);
});
