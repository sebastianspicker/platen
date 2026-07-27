import { deriveEditorReadiness } from '../editor-readiness.js';
import { activeContentSections } from './active-content-sections.js';
import { creationPanel, documentPanel, property } from './document-panel.js';
import { documentOperationSections } from './document-operation-sections.js';
import { inspectorShell } from './shell.js';
import { ocrSections } from './ocr-sections.js';
import { pdfkitInspectorSections } from './pdfkit-sections.js';
import { reviewSections } from './review-sections.js';
import { snapshotSections } from './snapshot-sections.js';
import { emptyAnalysis } from './surface-panels.js';

export {
  documentSurface,
  emptyAnalysis,
  pagesPanel,
  toolbar,
} from './surface-panels.js';

export function inspector(state) {
  const document = state.document;
  const analysis = state.analysis ?? emptyAnalysis;
  const info = analysis.inspection;
  const structure = analysis.structure;
  const readiness = deriveEditorReadiness(state, analysis);
  const selectedPage = state.selectedPage ?? 1;
  const selectedBoxEvidence = structure?.pageBoxes?.find(({ page }) => page === selectedPage);
  const engines = state.host?.engines ?? [];
  const availableEngines = engines.filter(({ available }) => available).length;

  return inspectorShell(document, `
      <details class="inspector-group" open>
        <summary>Document <span>Source and evidence</span></summary>
        <div class="inspector-group-content">${documentPanel(state, {
    analysis,
    info,
    structure,
    selectedBoxEvidence,
    ready: readiness.ready,
  })}</div>
      </details>
      <details class="inspector-group">
        <summary>Create <span>Derived files and page operations</span></summary>
        <div class="inspector-group-content">${creationPanel(state)}${documentOperationSections(state, analysis, readiness)}</div>
      </details>
      <details class="inspector-group">
        <summary>Inspect <span>Snapshots and active content</span></summary>
        <div class="inspector-group-content">${snapshotSections(state, readiness)}${activeContentSections(state, readiness, analysis)}</div>
      </details>
      <details class="inspector-group">
        <summary>Edit <span>Source-bound and derived edits</span></summary>
        <div class="inspector-group-content">${pdfkitInspectorSections(state, readiness)}</div>
      </details>
      <details class="inspector-group">
        <summary>Review <span>Prepress and accessibility</span></summary>
        <div class="inspector-group-content">${reviewSections(state, readiness)}</div>
      </details>
      <details class="inspector-group">
        <summary>OCR <span>Text and layout analysis</span></summary>
        <div class="inspector-group-content">${ocrSections(state, analysis, readiness)}</div>
      </details>
      <details class="inspector-group">
        <summary>Runtime <span>Local engine status</span></summary>
        <div class="inspector-group-content">
          <section class="property-section">
            <h3>Runtime</h3>
            ${property('Engines', engines.length ? `${availableEngines}/${engines.length} available` : 'Not probed')}
            ${property('Text pages', analysis.textPages.length)}
            ${property('Selected', document.isOpen ? `Page ${selectedPage}` : '—')}
          </section>
        </div>
      </details>
      <div class="disclosure"><strong>Local trust boundary</strong><br />Native PDF parsers process an immutable private copy. Link and active-content behavior inside the native viewer is browser-controlled; the app does not open attachments or run executable third-party plugins or cloud services.</div>
    `);
}
