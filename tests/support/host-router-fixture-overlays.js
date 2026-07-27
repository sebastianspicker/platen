import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ACCESSIBILITY_REMEDIATION_MEDIA_TYPE } from '../../scripts/host/accessibility-remediation-service.mjs';
import { DocumentStore } from '../../scripts/host/document-store.mjs';
import { DomainFacade } from '../../scripts/host/domain-facade.mjs';
import { InputAssetStore } from '../../scripts/host/input-asset-store.mjs';
import { createOperationProvenance } from '../../scripts/host/operation-provenance.mjs';
import {
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  ProjectBundleService,
  PROJECT_BUNDLE_MEDIA_TYPE,
} from '../../scripts/host/project-bundle-service.mjs';
import { createAppHandler } from '../../scripts/host/router.mjs';
import { WorkspaceStateStore } from '../../scripts/host/workspace-state.mjs';
import { makeTextPdf } from '../pdf-fixture.js';
import { invoke } from './host-router-fixture-base.js';
import { createDocumentOverlays } from './host-router-fixture-document-overlays.js';
import { createPlatformOverlays } from './host-router-fixture-platform-overlays.js';
import { createReviewOverlays } from './host-router-fixture-review-overlays.js';

function enabledServices(document, review, platform, options) {
  return {
    service: document.service,
    conversion: document.conversion,
    rasterMutations: document.rasterMutations,
    redactionPlans: options.redactionPlansEnabled ? review.redactionPlans : null,
    redactionPlanReports: options.redactionPlanReportsEnabled ? review.redactionPlanReports : null,
    comparisons: review.comparisons,
    prepress: options.prepressEnabled ? review.prepress : null,
    accessibilityReviews: review.accessibilityReviews,
    accessibilityRemediations: options.accessibilityRemediationEnabled
      ? review.accessibilityRemediations : null,
    standardsValidations: options.standardsEnabled ? review.standardsValidations : null,
    incrementalMetadata: options.incrementalMetadataEnabled
      ? platform.incrementalMetadata : null,
    pdfkitInspections: options.pdfkitEnabled ? platform.pdfkitInspections : null,
    pdfkitOutlineSplits: options.pdfkitEnabled ? platform.pdfkitOutlineSplits : null,
    pdfkitMutations: options.pdfkitMutationEnabled ? platform.pdfkitMutations : null,
    pdfkitProtection: options.pdfkitProtectionEnabled ? platform.pdfkitProtection : null,
    pdfkitSanitization: options.pdfkitSanitizationEnabled
      ? platform.pdfkitSanitization : null,
    pdfkitTextFieldWidget: options.pdfkitTextFieldWidgetEnabled
      ? platform.pdfkitTextFieldWidget : null,
    pluginSandboxStatus: options.pluginSandboxProbeEnabled
      ? platform.pluginSandboxStatus : null,
  };
}

async function fixture(context, {
  prepressEnabled = true, pdfkitEnabled = true, pdfkitMutationEnabled = true,
  pdfkitProtectionEnabled = true, pdfkitSanitizationEnabled = true,
  pdfkitTextFieldWidgetEnabled = true,
  incrementalMetadataEnabled = true,
  accessibilityRemediationEnabled = true, standardsEnabled = true,
  signatureTrustEnabled = true, redactionPlansEnabled = true,
  redactionPlanReportsEnabled = true,
  pluginSandboxProbeEnabled = true,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-router-test-'));
  const store = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(() => store.dispose());
  const workspaceState = new WorkspaceStateStore(store);
  const domainFacade = new DomainFacade(workspaceState);
  const projectBundles = new ProjectBundleService(store, workspaceState);
  const document = createDocumentOverlays();
  const review = createReviewOverlays();
  const platform = createPlatformOverlays();
  const options = {
    prepressEnabled, pdfkitEnabled, pdfkitMutationEnabled, pdfkitProtectionEnabled,
    pdfkitSanitizationEnabled, pdfkitTextFieldWidgetEnabled, incrementalMetadataEnabled,
    accessibilityRemediationEnabled, standardsEnabled, redactionPlansEnabled, redactionPlanReportsEnabled,
    pluginSandboxProbeEnabled,
  };
  const services = enabledServices(document, review, platform, options);
  const handler = createAppHandler({
    staticHandler: (_request, response) => response.end('static'),
    store,
    inputs,
    workspaceState,
    domainFacade,
    aecArtifacts: platform.aecArtifacts,
    projectBundles,
    ...services,
    signatureTrustReady: signatureTrustEnabled,
    token: 'test-session-token',
    host: '127.0.0.1',
    port: 4173,
  });
  return {
    handler, store, inputs, workspaceState, projectBundles,
    prepress: review.prepress,
    aecArtifacts: platform.aecArtifacts,
    redactionPlans: review.redactionPlans,
    redactionPlanReports: review.redactionPlanReports,
    accessibilityRemediations: review.accessibilityRemediations,
    standardsValidations: review.standardsValidations,
    incrementalMetadata: platform.incrementalMetadata,
    pdfkitOutlineSplits: platform.pdfkitOutlineSplits,
    pdfkitMutations: platform.pdfkitMutations,
    pdfkitProtection: platform.pdfkitProtection,
    pdfkitSanitization: platform.pdfkitSanitization,
    pdfkitTextFieldWidget: platform.pdfkitTextFieldWidget,
    pluginSandboxStatus: platform.pluginSandboxStatus,
  };
}

export {
  assert,
  createHash,
  writeFile,
  join,
  Readable,
  ACCESSIBILITY_REMEDIATION_MEDIA_TYPE,
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  PROJECT_BUNDLE_MEDIA_TYPE,
  createOperationProvenance,
  fixture,
  invoke,
  makeTextPdf,
};
