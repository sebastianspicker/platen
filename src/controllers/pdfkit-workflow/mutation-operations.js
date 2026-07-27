import {
  buildStandardMetadataMutation,
  buildIncrementalBleedBoxMutation,
  buildIncrementalPageVectorMutation,
  buildPdfKitInkAnnotationMutation,
  buildPdfKitLineAnnotationMutation,
  buildPdfKitLocalGoToMutation,
  buildPdfKitLocalGoToRemovalMutation,
  buildPdfKitMutation,
  buildPdfKitOutlineMutation,
  buildPdfKitOutlineRemovalMutation,
  buildPdfKitOutlineRenameMutation,
  buildPdfKitTargetedMutation,
} from '../../core/pdfkit-workflow-contract.js';
import { buildIncrementalGoToLinkMutation } from '../../core/pdf-incremental-goto-link-contract.js';
import { buildIncrementalNamedDestinationMutation } from '../../core/pdf-incremental-named-destination-contract.js';
import { buildAnnotationFlattenMutation } from '../../core/pdf-annotation-flatten-contract.js';
import { buildPageTextMutation } from '../../core/pdf-page-text-contract.js';

async function runAttachmentRemovalOperation({ confirm, ready, runArtifact }) {
  if (!ready('attachmentRemovalReady')) return;
  if (!confirm('Create a separate PDF with its sole embedded attachment removed? The fixed cross-platform writer accepts only one exact flat document-level attachment locus, proves logical deletion, and emits a closed rewrite without prior revisions or unreachable attachment objects. The attachment name and bytes are omitted from receipts; only their digests and byte count remain. This is not general attachment management or hidden-data sanitization.')) return;
  await runArtifact({
    method: 'runAttachmentRemoval', withoutMutation: true,
    resultKey: 'attachmentRemovalResult',
    busyAction: 'Removing one embedded attachment and independently validating a closed PDF…',
    message: (result) => `${result.artifact.displayName} created with one verified embedded attachment removed. The immutable source is unchanged.`,
  });
}

async function runAnnotationFlattenOperation({ state, showError, confirm, ready, runArtifact }) {
  if (!ready('annotationFlattenReady', true)) return;
  let mutation;
  try { mutation = buildAnnotationFlattenMutation(state); } catch (error) { showError(error); return; }
  if (!confirm('Create a separate closed-rewrite PDF with the selected square annotation flattened? The fixed profile accepts only the sole annotation in the document with one tiny resource-free normal appearance. It promotes that appearance into page content, removes the annotation object and prior revisions, and independently requires every validation render to remain identical. The immutable source stays unchanged.')) return;
  await runArtifact({
    method: 'runAnnotationFlatten', mutation,
    resultKey: 'annotationFlattenResult',
    busyAction: 'Flattening one source-bound square annotation and validating a closed PDF…',
    message: (result) => `${result.artifact.displayName} created with one verified square annotation promoted into page content. The immutable source is unchanged.`,
  });
}

const CONFIGURED_MUTATIONS = Object.freeze({
  javascriptRemoval: {
    capability: 'javascriptRemovalReady', withoutMutation: true,
    confirmation: 'Create a separate PDF with the one admitted document-level JavaScript locus removed? The writer logically deletes that exact action, then compacts the result so prior revisions and the admitted script bytes are absent. Unsupported actions and structures fail closed. This is not general hidden-data sanitization.',
    artifact: { method: 'runJavaScriptRemoval', resultKey: 'javascriptRemovalResult', busyAction: 'Removing one document-level JavaScript locus and independently validating a closed PDF…', message: (result) => `${result.artifact.displayName} created with one verified document-level JavaScript locus removed. The immutable source is unchanged.` },
  },
  goToLink: {
    capability: 'incrementalGoToLinkReady', builder: buildIncrementalGoToLinkMutation,
    confirmation: 'Create a separate append-only PDF with one local page link? The bounded cross-platform writer adds one direct /Dest /Fit annotation and preserves every source byte as the exact prefix. Existing links, actions, active content, signatures, and unsupported page or annotation structures fail closed.',
    artifact: { method: 'runIncrementalGoToLink', resultKey: 'incrementalGoToLinkResult', busyAction: 'Appending and independently validating a structure-preserving local page link…', message: (result) => `${result.artifact.displayName} created with one verified direct local page link. The immutable source is unchanged.` },
  },
  namedDestination: {
    capability: 'incrementalNamedDestinationReady', builder: buildIncrementalNamedDestinationMutation,
    confirmation: 'Create a separate append-only PDF with one named destination? The fixed cross-platform writer adds one /Fit target to an existing page and preserves every source byte as the exact prefix. Existing destinations, page annotations, actions, active content, signatures, and unsupported graphs fail closed. This is not general destination management.',
    artifact: { method: 'runIncrementalNamedDestination', resultKey: 'incrementalNamedDestinationResult', busyAction: 'Appending and independently validating one named destination…', message: (result) => `${result.artifact.displayName} created with one verified named destination. The immutable source is unchanged.` },
  },
  bleedBox: {
    capability: 'incrementalBleedBoxReady', builder: buildIncrementalBleedBoxMutation,
    confirmation: 'Create a separate append-only BleedBox copy? The local classic-xref engine appends one replacement revision of the same selected page object while preserving every source byte as the exact output prefix. It supports only explicit direct MediaBox, TrimBox, and BleedBox values in its strict passive subset and fails closed otherwise.',
    artifact: { method: 'runIncrementalBleedBox', resultKey: 'incrementalBleedBoxResult', busyAction: 'Appending and independently validating a structure-preserving BleedBox revision…', message: (result) => `${result.artifact.displayName} created with one verified same-page-object BleedBox revision. The immutable source is unchanged.` },
  },
  metadata: {
    capability: 'incrementalMetadataReady', builder: buildStandardMetadataMutation,
    confirmation: 'Create a separate append-only metadata copy? Every source byte remains as the exact output prefix, so prior metadata remains recoverable. This is not sanitization or privacy removal. The local writer accepts only its bounded unsigned, unencrypted, no-XMP classic-xref subset and fails closed otherwise.',
    artifact: { method: 'runIncrementalMetadata', resultKey: 'incrementalMetadataResult', busyAction: 'Appending and independently validating an object-preserving metadata revision…', message: (result) => `${result.artifact.displayName} created with a verified append-only metadata revision. The immutable source is unchanged; historical metadata remains in the output prefix.` },
  },
  pageVector: {
    capability: 'incrementalPageVectorReady', builder: buildIncrementalPageVectorMutation,
    confirmation: 'Create a separate append-only PDF with one fixed-stroke vector overlay? The local profile appends one 1pt black rectangle to the selected page, preserves every source byte as the exact output prefix, and verifies all constrained checks. This is not general vector editing, redaction, or signature-safe rewriting.',
    artifact: { method: 'runIncrementalPageVector', resultKey: 'incrementalPageVectorResult', busyAction: 'Appending and independently validating a structure-preserving page-vector revision…', message: (result) => `${result.artifact.displayName} created with one verified page-vector revision. The immutable source is unchanged.` },
  },
  pageText: {
    capability: 'pageTextReady', builder: buildPageTextMutation,
    confirmation: 'Create a separate append-only PDF with one black Helvetica text run? Text is printable ASCII only, and the selected page must be content-empty with no resources. Historical source bytes are retained in the exact output prefix. This is not general text editing, redaction, sanitization, or signature-safe rewriting.',
    artifact: { method: 'runPageText', resultKey: 'pageTextResult', busyAction: 'Appending and independently validating one fixed page-text run…', message: (result) => `${result.artifact.displayName} created with one verified black Helvetica text run. The immutable source is unchanged; historical bytes remain in the append-only output.` },
  },
});

async function runConfiguredMutation({ state, showError, confirm, ready, runArtifact }, config) {
  if (!ready(config.capability)) return;
  let mutation;
  try { mutation = config.builder?.(state); } catch (error) { showError(error); return; }
  if (!confirm(config.confirmation)) return;
  await runArtifact({ ...config.artifact, ...(config.withoutMutation ? { withoutMutation: true } : { mutation }) });
}

export function createPdfKitMutationOperations({ state, showError, confirm, ready, runArtifact }) {
  async function runPdfKitTextFieldWidget() {
    if (!ready('pdfkitTextFieldWidgetReady')) return;
    const mutation = {
      page: state.selectedPage ?? 1,
      rect: state.pdfkitTextFieldRect,
      fieldName: state.pdfkitTextFieldName,
      defaultValue: state.pdfkitTextFieldDefaultValue === '' ? null : state.pdfkitTextFieldDefaultValue,
    };
    if (!confirm('Create a separate PDF with one direct terminal text-field widget? Existing forms, signatures, actions, tags, layers, and unsupported graphs fail closed; the immutable source stays unchanged.')) return;
    await runArtifact({ method: 'addPdfKitTextFieldWidget', mutation, resultKey: 'pdfkitTextFieldWidgetResult', busyAction: 'Creating and independently validating a PDFKit text-field widget…', message: (result) => `${result.artifact.displayName} created with one verified text-field widget. The source is unchanged.` });
  }
  const runAttachmentRemoval = () => runAttachmentRemovalOperation({ confirm, ready, runArtifact });
  const runAnnotationFlatten = () => runAnnotationFlattenOperation({ state, showError, confirm, ready, runArtifact });
  const configured = (name) => runConfiguredMutation(
    { state, showError, confirm, ready, runArtifact }, CONFIGURED_MUTATIONS[name],
  );
  const runJavaScriptRemoval = () => configured('javascriptRemoval');
  const runIncrementalGoToLink = () => configured('goToLink');
  const runIncrementalNamedDestination = () => configured('namedDestination');
  const runIncrementalBleedBox = () => configured('bleedBox');
  const runIncrementalMetadata = () => configured('metadata');
  const runIncrementalPageVector = () => configured('pageVector');
  const runPageText = () => configured('pageText');

  async function runPdfKitMutation(kind) {
    if (!ready('pdfkitMutationReady', true)) return;
    let mutation; try { mutation = buildPdfKitMutation(kind, state); } catch (error) { showError(error); return; }
    const persistentPageBox = kind === 'page-box'
      && ['crop', 'bleed'].includes(mutation.pageBox?.box);
    const crop = mutation.pageBox?.box === 'crop';
    const pageBoxLabel = crop ? 'CropBox' : 'BleedBox';
    const confirmation = persistentPageBox
      ? crop
        ? 'Create a separate PDF with this persistent CropBox? Expanding the CropBox can reveal source content that was previously cropped from view. Signed, encrypted, active, out-of-MediaBox, and no-op inputs fail closed; the source stays unchanged.'
        : 'Create a separate PDF with this persistent BleedBox? It must remain inside the MediaBox, contain the unchanged TrimBox, and differ from the current resolved BleedBox. Signed, encrypted, active, and unsupported inputs fail closed; the source stays unchanged.'
      : 'Create a separate PDFKit-derived PDF? The source stays unchanged, but PDFKit may rewrite object structure, invalidate digital signatures, and alter unsupported objects.';
    if (!confirm(confirmation)) return;
    await runArtifact({ method: 'runPdfKitMutation', mutation, resultKey: 'pdfkitMutationResult', busyAction: persistentPageBox ? `Creating and independently validating a persistent ${pageBoxLabel} copy…` : `Creating a PDFKit-derived ${kind} copy…`, message: (result) => persistentPageBox ? `${result.artifact.displayName} created with a verified persistent ${pageBoxLabel}. The source is unchanged.` : `${result.artifact.displayName} created as a separate PDFKit-derived copy. The source is unchanged; existing signatures may be invalid.` });
  }

  async function runPdfKitTargetedMutation(kind) {
    if (!ready('pdfkitMutationReady', true)) return;
    let mutation; try { mutation = buildPdfKitTargetedMutation(kind, state); } catch (error) { showError(error); return; }
    const selectiveRemoval = kind === 'annotation-remove';
    const verb = kind === 'form-fill' ? 'fill the selected form field' : kind === 'annotation-update' ? 'update the selected annotation' : 'remove the selected annotation';
    const confirmation = selectiveRemoval ? 'Create a separate PDF and remove this selected reachable inert annotation occurrence? The helper compares the ordered raw reachable annotation descriptors before and after reopen. This does not scrub orphan bytes, prior revisions, or other hidden data. The source stays unchanged.' : `Create a separate PDFKit-derived PDF and ${verb}? Signed, encrypted, active-action, XFA, stale-locator, and unsupported targets fail closed. The source stays unchanged.`;
    if (!confirm(confirmation)) return;
    await runArtifact({ method: 'runPdfKitTargetedMutation', mutation, resultKey: 'pdfkitMutationResult', busyAction: selectiveRemoval ? 'Creating and validating a selective annotation-removal copy…' : `Creating a source-bound ${kind} copy…`, message: (result) => selectiveRemoval ? `${result.artifact.displayName} created with one verified reachable annotation removed. The source is unchanged.` : `${result.artifact.displayName} created from the exact inspected source locator. The source is unchanged.` });
  }

  async function runSpecialMutation(builder, method, confirmation, busyAction, message) {
    if (!ready('pdfkitMutationReady', true)) return;
    let mutation; try { mutation = builder(state); } catch (error) { showError(error); return; }
    if (!confirm(confirmation)) return;
    await runArtifact({ method, mutation, resultKey: 'pdfkitMutationResult', busyAction, message: (result) => `${result.artifact.displayName} ${message}` });
  }

  const runPdfKitLocalGoToMutation = () => runSpecialMutation(buildPdfKitLocalGoToMutation, 'runPdfKitLocalGoToMutation', 'Create a separate PDF with one local page link? The new link contains only an intra-document destination and PDFKit’s redundant local GoTo action. URI, remote-file, named, launch, and script actions fail closed; the source stays unchanged.', 'Creating a source-bound local page link…', 'created with one verified local GoTo link. The source is unchanged.');
  const runPdfKitLocalGoToRemovalMutation = () => runSpecialMutation(buildPdfKitLocalGoToRemovalMutation, 'runPdfKitLocalGoToRemovalMutation', 'Create a separate PDF with this exact local GoTo link annotation removed? The helper must prove the source-bound strict link shape, remove only that reachable annotation occurrence, and preserve every remaining ordered annotation descriptor and page geometry. This does not scrub hidden or historical bytes. The source stays unchanged.', 'Creating and validating an exact local-link removal copy…', 'created with one verified local GoTo link removed. The source is unchanged.');
  const runPdfKitOutlineMutation = () => runSpecialMutation(buildPdfKitOutlineMutation, 'runPdfKitOutlineMutation', 'Create a separate PDF with one top-level local bookmark? The helper preserves bounded direct-destination outlines and passive page geometry, while sources containing GoTo-action outlines fail closed because PDFKit normalizes them. The source stays unchanged.', 'Creating a source-bound outline bookmark…', 'created with one verified top-level local bookmark. The source is unchanged.');
  const runPdfKitOutlineRemovalMutation = () => runSpecialMutation(buildPdfKitOutlineRemovalMutation, 'runPdfKitOutlineRemovalMutation', 'Create a separate PDF with this exact top-level leaf bookmark removed? The helper must rederive its source-bound direct-destination locator, remove only that outline node, and preserve every remaining outline node, page snapshot, and ordered annotation inventory. The source stays unchanged.', 'Creating and validating an exact bookmark-removal copy…', 'created with one verified top-level leaf bookmark removed. The source is unchanged.');
  const runPdfKitOutlineRenameMutation = () => runSpecialMutation(buildPdfKitOutlineRenameMutation, 'runPdfKitOutlineRenameMutation', 'Create a separate PDF with this exact top-level leaf bookmark renamed? The helper must rederive its source-bound direct destination, change only the decoded NFC title, and preserve the outline tree, page snapshots, annotations, text, and renders. The source stays unchanged.', 'Creating and validating an exact bookmark-rename copy…', 'created with one verified top-level leaf bookmark renamed. The source is unchanged.');
  const runPdfKitLineAnnotationMutation = () => runSpecialMutation(buildPdfKitLineAnnotationMutation, 'runPdfKitLineAnnotationMutation', 'Create a separate PDF with one embedded straight-line annotation? Both line endings are fixed to None. Signed, encrypted, form-bearing, action/media/attachment-bearing, and automatic-presentation inputs fail closed; the source stays unchanged.', 'Creating a source-bound line annotation…', 'created with one verified inert line annotation. The source is unchanged.');
  const runPdfKitInkAnnotationMutation = () => runSpecialMutation(buildPdfKitInkAnnotationMutation, 'runPdfKitInkAnnotationMutation', 'Create a separate PDF with one embedded open ink path? The path has a fixed appearance and cannot carry actions, attachments, popups, style controls, or hidden author data. Signed, encrypted, form-bearing, active/media-bearing, and automatic-presentation inputs fail closed; the source stays unchanged.', 'Creating a source-bound ink annotation…', 'created with one verified inert open ink path. The source is unchanged.');

  async function runPdfKitMetadataSanitization() {
    if (!ready('pdfkitSanitizationReady')) return;
    if (!confirm('Create a separate metadata-sanitized PDF? This fixed profile removes document Info, custom Info, and catalog XMP only. It rejects unsupported structures instead of discarding them, rewrites the PDF, and does not claim hidden-data cleanup, prior-revision removal, secure erasure, or byte preservation. The source stays unchanged.')) return;
    await runArtifact({ method: 'sanitizePdfKitMetadata', withoutMutation: true, resultKey: 'pdfkitSanitizationResult', busyAction: 'Creating and validating a metadata-free PDF…', message: (result) => `${result.artifact.displayName} created with verified document Info, custom Info, and catalog XMP removal. The immutable source is unchanged.` });
  }

  return { runAnnotationFlatten, runAttachmentRemoval, runIncrementalBleedBox, runIncrementalGoToLink, runIncrementalNamedDestination, runIncrementalMetadata, runIncrementalPageVector, runPageText, runJavaScriptRemoval, runPdfKitMutation, runPdfKitTargetedMutation, runPdfKitTextFieldWidget, runPdfKitLocalGoToMutation, runPdfKitLocalGoToRemovalMutation, runPdfKitOutlineMutation, runPdfKitOutlineRemovalMutation, runPdfKitOutlineRenameMutation, runPdfKitLineAnnotationMutation, runPdfKitInkAnnotationMutation, runPdfKitMetadataSanitization };
}
