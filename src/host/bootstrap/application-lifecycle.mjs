import { createAppHandler } from '../transport/http/router.mjs';
import { createStaticHandler } from '../transport/http/static-files.mjs';
import { deliverProfessionalCapability, listProfessionalHandlers } from '../application/capabilities/capability-delivery-registry.mjs';
import { createProfessionalAccessibilityDelivery } from '../application/review/professional-accessibility-delivery.mjs';
import { createProfessionalPageOrganizationDelivery } from '../application/review/professional-page-organization-delivery.mjs';
import { createProfessionalContentEditingDelivery } from '../application/review/professional-content-editing-delivery.mjs';
import { createProfessionalPrintDelivery } from '../application/capabilities/standards-preflight-print.mjs';

export function createApplicationClose(automation, store) {
  let closeOperation = null;
  return () => {
    closeOperation ??= (async () => {
      const failures = [];
      for (const close of [automation?.automationJs?.close?.bind(automation.automationJs), automation?.batchPrint?.close?.bind(automation.batchPrint), automation?.preflightServer?.close?.bind(automation.preflightServer), automation?.webhooks?.close?.bind(automation.webhooks), automation?.conditionalWorkflows?.close?.bind(automation.conditionalWorkflows), automation?.scheduledJobs?.close?.bind(automation.scheduledJobs), automation?.worker?.close?.bind(automation.worker), automation?.queue?.close?.bind(automation.queue), store.dispose.bind(store)]) {
        try { await close?.(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Local application could not close cleanly.');
    })();
    return closeOperation;
  };
}

export function createProfessionalCapabilities({ store, documents, workflows }) {
  const professionalAccessibility = createProfessionalAccessibilityDelivery({ store, services: documents, deliver: deliverProfessionalCapability, list: listProfessionalHandlers });
  const professionalContentEditing = createProfessionalContentEditingDelivery({ store, services: documents, deliver: professionalAccessibility.deliver, list: listProfessionalHandlers });
  const professionalPageOrganization = createProfessionalPageOrganizationDelivery({ store, services: { ...documents, pdfkitMutations: workflows.pdfkitMutations, blankPageFactory: workflows.conversion }, deliver: professionalContentEditing.deliver, list: listProfessionalHandlers });
  const professionalPrint = createProfessionalPrintDelivery({ store, services: { ...documents, ...workflows }, deliver: professionalPageOrganization.deliver, list: listProfessionalHandlers });
  return Object.freeze({ professionalCapabilities: Object.freeze({ ...professionalPrint, deliverSourceBound: professionalAccessibility.deliverSourceBound, deliverTextSourceBound: professionalContentEditing.deliverSourceBound, deliverContentEditingSourceBound: professionalContentEditing.deliverSourceBound, deliverPageOrganizationSourceBound: professionalPageOrganization.deliverSourceBound, deliverAccessibilitySourceBound: professionalAccessibility.deliverSourceBound, deliverPrintSourceBound: professionalPrint.deliverSourceBound, inventorySourceBound: professionalAccessibility.inventorySourceBound }) });
}

export function createLocalApplicationHandler({ root, host, port, token, store, engine, inputs, workflows, workspaceState, optional, documents, pluginPackages, professionalCapabilities }) {
  return createAppHandler({ staticHandler: createStaticHandler({ root, host, port }), store, service: engine.service, inputs, ...workflows, workspaceState, standardsValidations: optional.standardsValidations, ...documents, pdfkitInspections: optional.pdfkitInspections, pdfkitOutlineSplits: optional.pdfkitOutlineSplits, pdfkitMutations: optional.pdfkitMutations, pdfkitProtection: optional.pdfkitProtection, pdfkitSanitization: optional.pdfkitSanitization, pdfkitTextFieldWidget: optional.pdfkitTextFieldWidget, signatureTrustReady: Boolean(engine.signatureTrustAdapter), signingIdentityReady: Boolean(engine.signingIdentityAdapter), signingIdentityDirectory: engine.signingIdentityDirectory, certificateSignature: engine.certificateSignature, hiddenDataSanitization: documents.hiddenDataSanitization, taggedRemediation: documents.taggedRemediation, taggedRemediationReady: Boolean(documents.taggedRemediation), jpegImage: documents.jpegImageBroker, jpegImageReplacement: documents.jpegImageReplacementBroker, jpegImageReplacementReady: Boolean(documents.jpegImageReplacementBroker), jpegImageReady: Boolean(documents.jpegImageBroker), pageLabels: documents.pageLabels, pageLabelsReady: Boolean(documents.pageLabels), advancedSearch: documents.advancedSearch, sensitivePatterns: documents.sensitivePatterns, redactionOverlayLabels: documents.redactionOverlayLabels, advancedSearchReady: Boolean(documents.advancedSearch), specialistContent: documents.specialistContent, specialistContentReady: Boolean(documents.specialistContent), pluginPackages, scannerDiscovery: optional.scannerDiscovery, scannerDiscoveryReady: Boolean(optional.scannerDiscovery), scannerAcquisition: optional.scannerAcquisition, scannerAcquisitionReady: Boolean(optional.scannerAcquisition), professionalCapabilities, token, host, port });
}
