import { validIncrementalNamedDestinationRequest } from '../core/pdf-incremental-named-destination-contract.js';
import { validAnnotationFlattenTarget } from '../core/pdf-annotation-flatten-contract.js';
import { validIncrementalAccessibilityMetadata } from '../core/pdf-incremental-accessibility-metadata-contract.js';
import { validAccessibilityAltText } from '../core/accessibility-alt-text-contract.js';
import { safeRewriteSourceReady } from './editor-readiness-helpers.js';

export function incrementalNamedDestinationReadiness({ state, passive, structure, pageCount }) {
  const inventory = structure?.namedDestinations;
  const request = {
    targetPage: Number(state.incrementalNamedDestinationTargetPage),
    name: String(state.incrementalNamedDestinationName ?? ''),
  };
  const editorReady = passive && state.host?.incrementalNamedDestinationReady === true
    && inventory?.truncated === false && Array.isArray(inventory.items)
    && inventory.items.length === 0;
  return Object.freeze({
    editorReady,
    ready: editorReady && validIncrementalNamedDestinationRequest(request)
      && request.targetPage <= pageCount,
  });
}

export function incrementalAccessibilityMetadataReadiness({ state, analysis, passive }) {
  const report = state.accessibilityReviewResult;
  const actions = new Set((report?.remediationPlan?.candidates ?? [])
    .filter(({ status }) => status === 'proposed-not-applied')
    .map(({ action }) => action));
  const checks = new Map((report?.checks ?? []).map((check) => [check.id, check.status]));
  const editorReady = passive
    && String(analysis.inspection?.tagged ?? '').toLowerCase() === 'no'
    && state.host?.incrementalAccessibilityMetadataReady === true
    && report?.kind === 'accessibility-review'
    && report.sourceDigest === analysis.sha256
    && report.remediationPlan?.truncated === false
    && actions.has('set-document-language')
    && actions.has('set-document-title')
    && checks.get('document-language') === 'warning'
    && checks.get('document-title') === 'warning';
  const request = {
    language: String(state.accessibilityDocumentLanguage ?? ''),
    title: String(state.accessibilityDocumentTitle ?? ''),
  };
  return Object.freeze({
    editorReady,
    ready: editorReady && validIncrementalAccessibilityMetadata(request),
  });
}

export function accessibilityAltTextReadiness({ state, analysis, ready }) {
  const report = state.accessibilityReviewResult;
  const candidates = (report?.remediationPlan?.candidates ?? []).filter((candidate) => (
    candidate?.action === 'author-image-alt-text'
      && candidate.status === 'proposed-not-applied'
      && /^[a-f0-9]{64}$/u.test(candidate.target?.locator ?? '')
  ));
  const editorReady = ready && state.host?.accessibilityRemediationReady === true
    && report?.kind === 'accessibility-review'
    && report.sourceDigest === analysis.sha256
    && report.remediationPlan?.truncated === false
    && candidates.length > 0;
  return Object.freeze({
    editorReady,
    ready: editorReady
      && candidates.some(({ target }) => (
        target.locator === state.accessibilityAltTextCandidateLocator
      ))
      && validAccessibilityAltText(state.accessibilityAltText),
  });
}

/**
 * Derives annotation-flatten readiness from one immutable snapshot of editor state.
 */
export function annotationFlattenReadiness({ state, ready, unsigned, info, formKind, analysis, structure, inspection, page }) {
  const safeRewriteSource = safeRewriteSourceReady({ ready, unsigned, info, formKind, analysis, structure });
  const inspectedAnnotations = inspection?.pages?.flatMap((entry) => (
    entry.annotationsTruncated === false ? entry.annotations ?? [] : [null]
  ));
  const selected = page?.annotations?.find(({ annotationIndex }) => (
    String(annotationIndex) === String(state.pdfkitExistingAnnotationIndex)
  ));
  const target = {
    page: Number(state.selectedPage),
    annotationIndex: Number(selected?.annotationIndex),
    fingerprint: selected?.fingerprint,
    subtype: selected?.subtype,
  };
  return safeRewriteSource
    && state.host?.annotationFlattenReady === true
    && structure?.xmpMetadata?.present === false
    && inspection?.pageCount === info?.pageCount
    && inspection?.optionalContent?.present === false
    && inspection?.outline?.truncated === false
    && (inspection?.outline?.items?.length ?? 0) === 0
    && inspection?.pageLabels?.present === false
    && Array.isArray(inspectedAnnotations) && inspectedAnnotations.length === 1
    && inspectedAnnotations[0] === selected
    && page?.rotation === 0
    && validAnnotationFlattenTarget(target);
}
