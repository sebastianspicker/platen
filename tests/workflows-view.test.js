import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowsView } from '../src/ui/workflows-view.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const state = (overrides = {}) => ({
  document: { isOpen: true, id: 'document-1', name: 'sample.pdf' },
  domainOperations: {
    review: { createAnnotation: { supported: true, semantics: 'Create a session-only review annotation.' } },
    forms: { xfa: { supported: false, semantics: 'XFA is unsupported.' } },
    redaction: { detectSensitiveText: { supported: true, semantics: 'No PDF bytes are changed.' }, apply: { supported: false, semantics: 'Applying is unsupported.' } },
    accessibility: { inspect: { supported: true, semantics: 'Inspect supplied summary.' } },
    signing: { certificateTrust: { supported: false, semantics: 'Certificate trust is unsupported.' }, verifyLocalIntent: { supported: true, semantics: 'Verify local audit chain.' } },
    AEC: { measure: { supported: true, semantics: 'Store local measurement.' } },
    collaboration: { createProject: { supported: true, semantics: 'Create offline-only project.' } },
  },
  selectedDomainOperation: { group: 'review', operation: 'createAnnotation' },
  domainPayload: '{"input":"<unsafe>"}',
  domainResult: { message: '<unsafe result>' },
  domainError: null,
  domainBusy: false,
  busyAction: null,
  host: { projectBundlesReady: true, portableProjectBundlesReady: true, aecArtifactsReady: true, aecNativeReady: true },
  selectedPage: 1,
  aecCalibrationPoints: '36,36;108,36', aecRealLength: '1', aecCalibrationUnit: 'ft',
  aecMeasurementPoints: '36,36;108,36', aecMeasurementKind: 'distance', aecDisplayUnit: 'ft',
  aecMeasurementLabel: 'Wall', aecLastCalibrationId: 'calibration-1', aecLastMeasurementId: 'measurement-1',
  error: null,
  ...overrides,
});

test('workflow screen renders every facade group with selectable supported and disabled unsupported operations', () => {
  const html = workflowsView(state());
  for (const name of ['Review', 'Forms', 'Redaction', 'Accessibility', 'Signing', 'AEC', 'Collaboration']) assert.match(html, new RegExp(`>${name}<`));
  assert.match(html, /data-domain-group="review" data-domain-operation="createAnnotation"/);
  assert.match(html, /data-domain-group="forms" data-domain-operation="xfa" disabled aria-disabled="true"/);
  assert.match(html, /data-action="show-editor"/);
  assert.match(html, /data-action="show-workflows"/);
  assert.match(html, /id="domain-payload"/);
  assert.match(html, /data-action="run-domain-operation"/);
  assert.match(html, /data-action="export-project-bundle"/);
  assert.match(html, /data-action="choose-project-bundle"/);
  assert.match(html, /id="project-bundle-picker"/);
  assert.match(html, /exact PDF bytes together with the complete revisioned, digest-bound workspace/);
  assert.match(html, /no secrets, paths, executable content, or network synchronization/);
  assert.match(html, /data-action="create-aec-calibration"/);
  assert.match(html, /data-action="create-aec-measurement"/);
  assert.match(html, /data-action="publish-aec-measurement"/);
  assert.match(html, /bounded ISO\/PDF Measure scale/);
  assert.match(html, /Count stays uncalibrated/);
  assert.match(html, /session-only sidecar records/);
  assert.match(html, /never claims PDF-byte mutation, certificate trust, or remote synchronization/);
  assert.doesNotMatch(html, /undefined/);
});

test('workflow screen escapes payload, result, errors, and host semantics', () => {
  const html = workflowsView(state({ domainError: '<unsafe error>', selectedDomainOperation: { group: 'review', operation: '<evil>' }, domainOperations: { review: { '<evil>': { supported: true, semantics: '<unsafe semantics>' } } } }));
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /&lt;unsafe error&gt;/);
  assert.match(html, /&lt;unsafe semantics&gt;/);
  assert.doesNotMatch(html, /<unsafe/);
});

test('workflow screen has loading and no-document states plus responsive styling', () => {
  const loading = workflowsView(state({ domainOperations: null, document: { isOpen: false, id: null, name: null }, selectedDomainOperation: null }));
  assert.match(loading, /Loading local workflows/);
  assert.match(loading, /Open a local PDF/);
  assert.match(loading, /class="workflow-runner"[^>]*data-state="loading"/);
  assert.match(loading, /id="domain-payload"[^>]*disabled/);
  assert.match(loading, /run-domain-operation" disabled/);
  const css = ['workflows-layout.css', 'workflows-runner.css', 'responsive.css', 'mobile.css']
    .map((name) => readFileSync(join(root, 'styles', name), 'utf8'))
    .join('\n');
  assert.match(css, /\.workflow-layout/);
  assert.match(css, /@media \(max-width: 620px\).*\.workflow-layout/s);
});

test('loading operation map never presents a stale actionable runner selection', () => {
  const html = workflowsView(state({ domainOperations: null }));
  const runner = html.match(/<aside class="workflow-runner"[\s\S]*?<\/aside>/)?.[0] ?? '';
  assert.match(runner, /data-state="loading"/);
  assert.match(runner, /Operation map loading/);
  assert.match(runner, /class="workflow-selection workflow-selection-unavailable" role="status"/);
  assert.match(runner, /id="domain-payload"[^>]*disabled/);
  assert.match(runner, /data-action="run-domain-operation" disabled/);
  assert.doesNotMatch(runner, /<strong>Review<\/strong>|Create Annotation/);
  assert.doesNotMatch(runner, /Local result|unsafe result/);
});

test('no-document runner disables request editing even when the operation map is ready', () => {
  const html = workflowsView(state({ document: { isOpen: false, id: null, name: null } }));
  const runner = html.match(/<aside class="workflow-runner"[\s\S]*?<\/aside>/)?.[0] ?? '';
  assert.match(runner, /data-state="no-document"/);
  assert.match(runner, /<strong>Open a local PDF<\/strong>/);
  assert.match(runner, /id="domain-payload"[^>]*disabled/);
  assert.match(runner, /data-action="run-domain-operation" disabled/);
  assert.doesNotMatch(runner, /<strong>Review<\/strong>|Create Annotation/);
  assert.doesNotMatch(runner, /Local result|unsafe result/);
});

test('workflow screen exposes selection semantics and separates non-interactive result status', () => {
  const html = workflowsView(state({ domainBusy: true, busyAction: 'run-domain-operation' }));
  assert.match(html, /data-domain-group="review" data-domain-operation="createAnnotation"[^>]*aria-pressed="true"/);
  assert.match(html, /data-domain-group="forms" data-domain-operation="xfa"[^>]*disabled[^>]*aria-disabled="true"/);
  assert.match(html, /class="workflow-result workflow-result-running"[^>]*aria-labelledby/);
  assert.doesNotMatch(html, /class="workflow-result workflow-result-running"[^>]*role="status"/);
  assert.match(html, /class="workflow-result-state" role="status"/);
  assert.doesNotMatch(html, /workflow-result[\s\S]*<button/);
  assert.match(html, /data-action="run-domain-operation"/);
});

test('workflow screen renders explicit empty operation state without an interactive live region', () => {
  const html = workflowsView(state({ domainOperations: Object.fromEntries(['review', 'forms', 'redaction', 'accessibility', 'signing', 'AEC', 'collaboration'].map((group) => [group, {}])) }));
  assert.match(html, /class="workflow-state workflow-state-empty"/);
  assert.doesNotMatch(html, /class="workflow-state workflow-state-empty"[^>]*role="status"/);
});

test('workflow screen ignores inherited operation groups and uses unknown-group fallbacks', () => {
  const operations = Object.create({ review: { inherited: { supported: true } } });
  operations.constructor = { inspect: { supported: false, semantics: 'Unknown group fallback.' } };
  const html = workflowsView(state({
    domainOperations: operations,
    selectedDomainOperation: { group: 'review', operation: 'inherited' },
  }));
  assert.match(html, /<h2 id="workflow-group-constructor">Constructor<\/h2>/);
  assert.match(html, /Local prototype domain operations\./);
  assert.match(html, /data-state="unavailable"/);
  assert.doesNotMatch(html, /data-domain-group="review"/);
});
test('AEC workflow exposes current-revision legend export with explicit digest-only boundary', () => {
  const html = workflowsView(state({ document: { isOpen: true, name: 'x.pdf' }, analysis: { documentId: 'doc' }, host: { aecArtifactsReady: true, aecMeasurementLegendReady: true }, aecMeasurementIds: ['m-1'], aecLegendStatus: 'success', domainRevision: 2 }));
  assert.match(html, /generate-aec-measurement-legend/); assert.match(html, /Labels are represented only as digests/);
});
