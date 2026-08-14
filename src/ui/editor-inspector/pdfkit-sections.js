import {
  annotationFlattenResult,
  incrementalBleedBoxResult,
  incrementalPageVectorResult,
  pageTextResult,
  incrementalGoToLinkResult,
  incrementalNamedDestinationResult,
  incrementalMetadataResult,
  pdfkitMutationResult,
  pdfkitTextFieldWidgetResult,
} from '../editor-result-views.js';
import {
  pdfKitLocalGoToRemovalCandidates,
  pdfKitOutlineRemovalCandidates,
  pdfKitOutlineRenameCandidates,
} from '../../core/pdfkit-workflow-contract.js';
import { pdfkitBasicEditSections } from './pdfkit-basic-edit-sections.js';
import { pdfkitMarkupSections } from './pdfkit-markup-sections.js';
import { pdfkitProtectionSections } from './pdfkit-protection-sections.js';
import { pdfkitTargetedSections } from './pdfkit-targeted-sections.js';
import { pdfkitLayerSections } from './pdfkit-layer-sections.js';
import { acroFormSections } from './acroform-sections.js';

function pdfkitContext(state, readiness) {
  const pdfkitPage = state.pdfkitInspectionResult?.pages?.find(
    ({ index }) => index === (state.selectedPage ?? 1),
  );
  const pdfkitWidgets = (pdfkitPage?.widgets ?? []).filter((widget) => (
    ['text', 'choice'].includes(widget.fieldType)
      || (widget.fieldType === 'button' && ['checkbox', 'radio'].includes(widget.controlKind))
  ));
  const selectedPdfkitWidget = pdfkitWidgets.find(
    ({ annotationIndex }) => String(annotationIndex) === String(state.pdfkitWidgetIndex),
  );
  const pdfkitExistingAnnotations = (pdfkitPage?.annotations ?? []).filter(
    ({ subtype }) => ['freeText', 'square', 'circle', 'highlight'].includes(subtype),
  );
  const reportedPageCount = state.pdfkitInspectionResult?.pageCount;
  const pdfkitPageCount = Number.isSafeInteger(reportedPageCount)
    && reportedPageCount >= 1 && reportedPageCount <= 100
    ? reportedPageCount
    : 0;
  const pdfkitCurrentRotation = [0, 90, 180, 270].includes(pdfkitPage?.rotation)
    ? pdfkitPage.rotation
    : null;
  return {
    ...readiness,
    pdfkitWidgets,
    selectedPdfkitWidget,
    pdfkitExistingAnnotations,
    pdfkitLocalLinkRemovalCandidates: pdfKitLocalGoToRemovalCandidates(
      pdfkitPage,
      pdfkitPageCount,
    ),
    pdfkitOutlineRemovalCandidates: pdfKitOutlineRemovalCandidates(
      state.pdfkitInspectionResult?.outline,
    ),
    pdfkitOutlineRenameCandidates: pdfKitOutlineRenameCandidates(
      state.pdfkitInspectionResult?.outline,
    ),
    pdfkitPageCount,
    localLinkPageCount: readiness.incrementalGoToLinkEditorReady
      ? state.analysis?.inspection?.pageCount : pdfkitPageCount,
    localLinkEditorReady: readiness.incrementalGoToLinkEditorReady
      || readiness.pdfkitLocalLinkReady,
    incrementalNamedDestinationPageCount: readiness.incrementalNamedDestinationEditorReady
      ? state.analysis?.inspection?.pageCount : 0,
    pdfkitCurrentRotation,
  };
}

export function pdfkitInspectorSections(state, readiness) {
  const context = pdfkitContext(state, readiness);
  return `      <section class="property-section pdfkit-mutation-section">
        <h3>Structure-preserving edits + PDFKit-derived fallbacks</h3>
        <p class="field-help">Each action creates and downloads a separate, non-rasterized PDF while the immutable source stays open and unchanged. Standard metadata, strict explicit BleedBox edits, and the bounded direct local-link profile use local append-only revisions. Other controls use PDFKit, which may rewrite unrelated object serialization or alter unsupported tags, layers, and appearance streams. Run the pinned inspection for PDFKit operations. Targeted operations require an exact-source locator and reject signed, encrypted, active-action, JavaScript, XFA, stale, or unsupported inputs.</p>
        ${pdfkitBasicEditSections(state, context)}
        ${pdfkitMarkupSections(state, context)}
        ${pdfkitTargetedSections(state, context)}
        ${pdfkitLayerSections(state)}
        ${acroFormSections(state)}
        <div class="nested-control-group" role="group" aria-labelledby="pdfkit-text-field-widget-heading">
          <h4 id="pdfkit-text-field-widget-heading">Create text field</h4>
          <label for="pdfkit-text-field-name">Field name</label>
          <input id="pdfkit-text-field-name" type="text" maxlength="64" value="${state.pdfkitTextFieldName ?? ''}" ${context.pdfkitTextFieldWidgetReady ? '' : 'disabled'} />
          <label for="pdfkit-text-field-default">Default value</label>
          <input id="pdfkit-text-field-default" type="text" maxlength="256" value="${state.pdfkitTextFieldDefaultValue ?? ''}" ${context.pdfkitTextFieldWidgetReady ? '' : 'disabled'} />
          <div class="inline-fields"><label>X <input id="pdfkit-text-field-x" type="number" value="${state.pdfkitTextFieldRect?.x ?? 36}" ${context.pdfkitTextFieldWidgetReady ? '' : 'disabled'} /></label><label>Y <input id="pdfkit-text-field-y" type="number" value="${state.pdfkitTextFieldRect?.y ?? 36}" ${context.pdfkitTextFieldWidgetReady ? '' : 'disabled'} /></label><label>W <input id="pdfkit-text-field-width" type="number" value="${state.pdfkitTextFieldRect?.width ?? 180}" ${context.pdfkitTextFieldWidgetReady ? '' : 'disabled'} /></label><label>H <input id="pdfkit-text-field-height" type="number" value="${state.pdfkitTextFieldRect?.height ?? 24}" ${context.pdfkitTextFieldWidgetReady ? '' : 'disabled'} /></label></div>
          <button class="button" data-action="create-pdfkit-text-field-widget" ${context.pdfkitTextFieldWidgetReady ? '' : 'disabled'}>Create text-field widget</button>
          <p class="field-help">Creates exactly one direct terminal single-line text widget on the selected page. Existing forms, signatures, actions, tags, layers, and unsupported graphs are rejected.</p>
        </div>
        ${state.host?.pdfkitMutationReady ? (state.pdfkitInspectionResult ? '' : '<p class="field-help">Run the pinned PDFKit inspection to bind controls to this exact source digest.</p>') : '<p class="field-help">Build the optional release helper with npm run native:build:pdfkit to enable these macOS-only derived-copy controls.</p>'}
        ${incrementalBleedBoxResult(state)}
        ${incrementalGoToLinkResult(state)}
        ${incrementalNamedDestinationResult(state)}
        ${incrementalPageVectorResult(state)}
        ${pageTextResult(state)}
        ${incrementalMetadataResult(state)}
        ${annotationFlattenResult(state)}
        ${pdfkitMutationResult(state)}
        ${pdfkitTextFieldWidgetResult(state)}
      </section>
      ${pdfkitProtectionSections(state, readiness)}`;
}
