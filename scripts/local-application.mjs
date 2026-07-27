import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PopplerAdapter } from './host/adapters/poppler.mjs';
import { TesseractAdapter } from './host/adapters/tesseract.mjs';
import { OcrImageAdapter } from './host/adapters/ocr-image.mjs';
import { GhostscriptAdapter } from './host/adapters/ghostscript.mjs';
import { QpdfAdapter } from './host/adapters/qpdf.mjs';
import { ImageMagickAdapter } from './host/adapters/imagemagick.mjs';
import { LibreOfficeAdapter } from './host/adapters/libreoffice.mjs';
import { RasterMutationAdapter } from './host/adapters/raster-mutation.mjs';
import { AccessibilityRemediationService } from './host/accessibility-remediation-service.mjs';
import { AccessibilityReviewService } from './host/accessibility-review-service.mjs';
import { AecArtifactService } from './host/aec-artifact-service.mjs';
import { PdfReviewMeasurementService } from './host/pdf-review-measurement-service.mjs';
import { PdfReviewSharedExchangeService } from './host/pdf-review-shared-exchange-service.mjs';
import { PdfReviewNotificationsService } from './host/pdf-review-notifications-service.mjs';
import { ConversionService } from './host/conversion-service.mjs';
import { DocumentStore } from './host/document-store.mjs';
import { DomainFacade } from './host/domain-facade.mjs';
import { EngineRegistry } from './host/engine-registry.mjs';
import { InputAssetStore } from './host/input-asset-store.mjs';
import { GhostscriptIccProfileProvider } from './host/icc-profile-provider.mjs';
import { PdfIncrementalMetadataService } from './host/pdf-incremental-metadata-service.mjs';
import { PdfIncrementalBleedBoxService } from './host/pdf-incremental-bleed-box-service.mjs';
import { PdfIncrementalGoToLinkService } from './host/pdf-incremental-goto-link-service.mjs';
import { PdfIncrementalBatchLinkService } from './host/pdf-incremental-batch-link-service.mjs';
import { PdfIncrementalNamedDestinationService } from './host/pdf-incremental-named-destination-service.mjs';
import { PdfPageVectorService } from './host/pdf-page-vector-service.mjs';
import { PdfIncrementalPageTransitionService } from './host/pdf-incremental-page-transition-service.mjs';
import { PdfPageTextService } from './host/pdf-page-text-service.mjs';
import { PdfFullPageRedactionService } from './host/pdf-full-page-redaction-service.mjs';
import { PdfPrinterMarksService } from './host/pdf-printer-marks-service.mjs';
import { PdfPageBackgroundService } from './host/pdf-page-background-service.mjs';
import { PdfLayerDefaultsService } from './host/pdf-layer-defaults-service.mjs';
import { PdfCertificateSignatureService } from './host/pdf-certificate-signature-service.mjs';
import { PdfHiddenDataSanitizationService } from './host/pdf-hidden-data-sanitization-service.mjs';
import { PdfAcroFormCheckboxService } from './host/pdf-acroform-checkbox-service.mjs';
import { PdfAcroFormRadioService } from './host/pdf-acroform-radio-service.mjs';
import { PdfAcroFormTextFieldService } from './host/pdf-acroform-text-field-service.mjs';
import { PdfAcroFormBarcodeService } from './host/pdf-acroform-barcode.mjs';
import { PdfFormJavaScriptInventoryService } from './host/pdf-form-javascript.mjs';
import { PdfAcroFormChoiceService } from './host/pdf-acroform-choice-service.mjs';
import { PdfAcroFormSignatureFieldService } from './host/pdf-acroform-signature-field-service.mjs';
import { PdfAcroFormTabOrderTooltipService } from './host/pdf-acroform-tab-order-tooltip-service.mjs';
import { PdfAccessibilityFormSemanticsService } from './host/pdf-accessibility-form-semantics.mjs';
import { PdfAccessibilityTableSemanticsService } from './host/pdf-accessibility-table-semantics.mjs';
import { PdfTextReflowService } from './host/pdf-text-reflow.mjs';
import { PdfBatesNumberingService } from './host/pdf-bates-numbering-service.mjs';
import { PdfTaggedRemediationService } from './host/pdf-tagged-remediation-service.mjs';
import { PdfJpegImageService } from './host/pdf-jpeg-image-service.mjs';
import { PdfJpegImageInputBroker } from './host/pdf-jpeg-image-input-broker.mjs';
import { PdfJpegImageReplacementService } from './host/pdf-jpeg-image-replacement-service.mjs';
import { PdfJpegImageReplacementInputBroker } from './host/pdf-jpeg-image-replacement-input-broker.mjs';
import { PdfPageLabelsService } from './host/pdf-page-labels-service.mjs';
import { PdfAdvancedSearchService } from './host/pdf-advanced-search-service.mjs';
import { PdfSpecialistContentService } from './host/pdf-specialist-content-service.mjs';
import { AecMeasurementLegendService } from './host/aec-measurement-legend-service.mjs';
import { SigningIdentityDirectoryService } from './host/signing-identity-directory-service.mjs';
import { PdfIncrementalAccessibilityMetadataService } from './host/pdf-incremental-accessibility-metadata-service.mjs';
import { PdfJavaScriptRemovalService } from './host/pdf-javascript-removal-service.mjs';
import { PdfAttachmentRemovalService } from './host/pdf-attachment-removal-service.mjs';
import { PdfFileAudioAttachmentService } from './host/pdf-file-audio-attachment-service.mjs';
import { PdfAccessibilityLinksBookmarksService } from './host/pdf-accessibility-links-bookmarks-service.mjs';
import { PdfSpellcheckService } from './host/pdf-spellcheck-service.mjs';
import { PdfAnnotationFlattenService } from './host/pdf-annotation-flatten-service.mjs';
import { PdfFastWebViewService } from './host/pdf-fast-web-view-service.mjs';
import { PdfOoxmlExportService } from './host/pdf-ooxml-export.mjs';
import { OcrEditableOutputService, receiptFromOcrLayout } from './host/ocr-editable-output.mjs';
import { ComparisonPackageService } from './host/comparison-package-service.mjs';
import { CommentsToOfficeService } from './host/comments-to-office-service.mjs';
import { HostError } from './host/host-error.mjs';
import {
  stagePdfKitRuntime,
  stageSignatureTrustRuntime,
  stageSigningIdentityRuntime,
  stageStandardsValidationRuntime,
  stageScannerDiscoveryRuntime,
} from './host/local-application-optional-services.mjs';
import { PrepressService } from './host/prepress-service.mjs';
import { ProjectBundleService } from './host/project-bundle-service.mjs';
import { createProcessLimiter } from './host/process-runner.mjs';
import { PluginSandboxStatusService } from './host/plugin-sandbox-status-service.mjs';
import { RasterMutationService } from './host/raster-mutation-service.mjs';
import { RedactionPlanService } from './host/redaction-plan-service.mjs';
import { RedactionPlanReportService } from './host/redaction-plan-report-service.mjs';
import { createAppHandler } from './host/router.mjs';
import { WorkspaceStateStore } from './host/workspace-state.mjs';
import { createStaticHandler } from './server-lib.mjs';
import { createLocalApplicationAutomation } from './host/local-application-automation.mjs';
import { PublisherTrustAuthority } from './host/publisher-trust-authority.mjs';
import { PluginPackageStore } from './host/plugin-package-store.mjs';
import { PluginRuntimeAuthorityRegistry } from './host/plugin-runtime-authority-registry.mjs';
import { deliverProfessionalCapability, listProfessionalHandlers } from './host/professional-capability/index.mjs';

async function createEngineRuntime({ root, sessionRoot, runner, store, inputs, PdfServiceClass }) {
  const pluginSandboxStatus = new PluginSandboxStatusService({ runner });
  const registry = new EngineRegistry({ runner });
  const adapter = new PopplerAdapter({ registry, runner });
  const ocrAdapter = new TesseractAdapter({ registry, runner });
  const ocrImageAdapter = new OcrImageAdapter({ registry, runner });
  const ghostscript = new GhostscriptAdapter({ registry, runner });
  const qpdf = new QpdfAdapter({ registry, runner });
  const libreOffice = new LibreOfficeAdapter({ registry, runner });
  const imageMagick = new ImageMagickAdapter({ registry, runner });
  const raster = new RasterMutationAdapter({ registry, runner });
  const { signatureTrustAdapter, signatureTrustHelper } = await stageSignatureTrustRuntime({ root, sessionRoot, runner });
  const { signingIdentityAdapter, signingIdentityHelper } = await stageSigningIdentityRuntime({ root, sessionRoot, runner });
  const service = new PdfServiceClass({ store, registry, adapter, ocrAdapter, ocrImageAdapter, signatureTrustAdapter });
  const certificateSignature = new PdfCertificateSignatureService({ store, adapter: signingIdentityAdapter });
  const signingIdentityDirectory = new SigningIdentityDirectoryService({ root: sessionRoot, adapter: signingIdentityAdapter });
  return { pluginSandboxStatus, registry, adapter, ghostscript, qpdf, libreOffice, imageMagick, raster, service, certificateSignature, signingIdentityDirectory, signatureTrustAdapter, signatureTrustHelper, signingIdentityAdapter, signingIdentityHelper, inputs };
}

async function createOptionalRuntime({ root, sessionRoot, runner, store, service, adapter }) {
  const { standardsValidations, standardsValidator } = await stageStandardsValidationRuntime({ root, sessionRoot, runner, store });
  const pdfkit = await stagePdfKitRuntime({ root, sessionRoot, runner, store, pdfService: service, poppler: adapter });
  const scanner = await stageScannerDiscoveryRuntime({ root, sessionRoot, runner, store, inspection: service });
  return { standardsValidations, standardsValidator, ...pdfkit, ...scanner };
}

function createDocumentServices({ store, inputs, adapter, service, registry }) {
  const jpegImage = new PdfJpegImageService({ store });
  const jpegImageBroker = new PdfJpegImageInputBroker({ inputs, service: jpegImage, store });
  const jpegImageReplacement = new PdfJpegImageReplacementService({ store, poppler: adapter });
  const jpegImageReplacementBroker = new PdfJpegImageReplacementInputBroker({ inputs, service: jpegImageReplacement, store });
  const pageLabels = new PdfPageLabelsService({ store });
  const advancedSearch = new PdfAdvancedSearchService({ store, inspection: service });
  const spellcheck = new PdfSpellcheckService({ store, inspection: service });
  const specialistContent = new PdfSpecialistContentService({ store });
  const acroFormTextField = new PdfAcroFormTextFieldService({ store });
  const aecMeasurementLegend = new AecMeasurementLegendService();
  const ocrEditableOutput = new OcrEditableOutputService({ store, ocr: {
    inspect: service.inspect.bind(service),
    extractReceipt: async (documentId, pageCount, { signal, language }) => {
      if (language !== 'eng') throw new HostError('OCR_LANGUAGE_UNAVAILABLE', 'Editable OCR output supports only the fixed eng language.', 400);
      const layout = await service.analyzeOcrLayout(documentId, { language, pages: Array.from({ length: pageCount }, (_, index) => index + 1), cleanupPreset: 'none', segmentation: 'auto', detectTables: false, signal });
      const engine = await registry.probe('tesseract');
      return receiptFromOcrLayout(layout, { engineVersion: engine.version });
    },
  } });
  return {
    incrementalMetadata: new PdfIncrementalMetadataService({ store, poppler: adapter }),
    incrementalBleedBox: new PdfIncrementalBleedBoxService({ store, poppler: adapter }),
    incrementalGoToLink: new PdfIncrementalGoToLinkService({ store, poppler: adapter }),
    incrementalBatchLink: new PdfIncrementalBatchLinkService({ store, poppler: adapter }),
    incrementalNamedDestination: new PdfIncrementalNamedDestinationService({ store, poppler: adapter }),
    incrementalPageVector: new PdfPageVectorService({ store, poppler: adapter }),
    incrementalPageTransition: new PdfIncrementalPageTransitionService({ store }),
    fileAudioAttachments: new PdfFileAudioAttachmentService({ store, inputs }),
    accessibilityLinksBookmarks: new PdfAccessibilityLinksBookmarksService({ store }),
    pageText: new PdfPageTextService({ store, poppler: adapter }),
    fullPageRedaction: new PdfFullPageRedactionService({ store, poppler: adapter }),
    printerMarks: new PdfPrinterMarksService({ store }),
    pageBackground: new PdfPageBackgroundService({ store }),
    layerDefaults: new PdfLayerDefaultsService({ store }),
    hiddenDataSanitization: new PdfHiddenDataSanitizationService({ store }),
    acroFormCheckbox: new PdfAcroFormCheckboxService({ store }),
    acroFormRadio: new PdfAcroFormRadioService({ store }),
    acroFormTextField,
    acroFormBarcode: new PdfAcroFormBarcodeService({ store }),
    formJavaScriptInventory: new PdfFormJavaScriptInventoryService({ store }),
    acroFormChoice: new PdfAcroFormChoiceService({ store }),
    acroFormSignatureField: new PdfAcroFormSignatureFieldService({ store }),
    acroFormTabOrderTooltip: new PdfAcroFormTabOrderTooltipService({ store }),
    accessibilityFormSemantics: new PdfAccessibilityFormSemanticsService({ store }),
    accessibilityTableSemantics: new PdfAccessibilityTableSemanticsService({ store }),
    textReflow: new PdfTextReflowService({ store }),
    batesNumbering: new PdfBatesNumberingService({ store }),
    aecMeasurementLegend,
    taggedRemediation: new PdfTaggedRemediationService({ store }),
    jpegImage,
    jpegImageBroker,
    jpegImageReplacement,
    jpegImageReplacementBroker,
    pageLabels,
    advancedSearch,
    spellcheck,
    specialistContent,
    incrementalAccessibilityMetadata: new PdfIncrementalAccessibilityMetadataService({ store, poppler: adapter }),
    javascriptRemoval: new PdfJavaScriptRemovalService({ store, poppler: adapter }),
    attachmentRemoval: new PdfAttachmentRemovalService({ store, poppler: adapter }),
    annotationFlatten: new PdfAnnotationFlattenService({ store, poppler: adapter }),
    service,
    ooxmlExport: new PdfOoxmlExportService({ store, extractor: {
      inspect: service.inspect.bind(service),
      extractText: async (documentId, pageCount, options) => ({
        sourceDigest: store.getDocument(documentId).sha256,
        pageCount,
        pages: await service.extractText(documentId, pageCount, options),
      }),
    } }),
    ocrEditableOutput,
  };
}

function createWorkflowServices({ store, inputs, service, adapter, ghostscript, qpdf, libreOffice, imageMagick, raster, registry, pdfkitAdapter, workspaceState, pdfkitInspections, ComparisonServiceClass }) {
  const conversion = new ConversionService({ documents: store, inputs, poppler: adapter, ghostscript, libreOffice, imageMagick });
  const domainFacade = new DomainFacade(workspaceState);
  const aecArtifacts = new AecArtifactService({ store, pdfService: service, workspaceState, poppler: adapter, pdfkit: pdfkitAdapter });
  const reviewMeasurements = new PdfReviewMeasurementService({ store, pdfService: service, workspaceState, poppler: adapter, pdfkit: pdfkitAdapter });
  const reviewSharedExchange = new PdfReviewSharedExchangeService({ documents: store, workspace: workspaceState });
  const commentsToOffice = new CommentsToOfficeService({ documents: store, workspace: workspaceState });
  const reviewNotifications = new PdfReviewNotificationsService({ documents: store, workspace: workspaceState });
  const projectBundles = new ProjectBundleService(store, workspaceState, { validateDocument: (documentId, options) => service.inspect(documentId, options) });
  const rasterMutations = new RasterMutationService({ store, poppler: adapter, imageMagick, raster });
  const redactionPlans = new RedactionPlanService({ documentStore: store, workspaceStateStore: workspaceState, poppler: adapter, rasterMutations });
  const redactionPlanReports = new RedactionPlanReportService({ documentStore: store, workspaceStateStore: workspaceState });
  const comparisons = new ComparisonServiceClass({ store, pdfService: service, workspaceState });
  const comparisonPackages = new ComparisonPackageService({ store, comparison: comparisons });
  const prepress = new PrepressService({ store, pdfService: service, poppler: adapter, ghostscript, imageMagick, iccProfileProvider: new GhostscriptIccProfileProvider({ registry }) });
  const accessibilityReviews = new AccessibilityReviewService({ store, pdfService: service, pdfkitInspectionService: pdfkitInspections });
  const accessibilityRemediations = new AccessibilityRemediationService({ documentStore: store, workspaceStateStore: workspaceState, reviewProvider: accessibilityReviews });
  return { conversion, domainFacade, aecArtifacts, reviewMeasurements, reviewSharedExchange, commentsToOffice, reviewNotifications, projectBundles, rasterMutations, redactionPlans, redactionPlanReports, comparisons, comparisonPackages, prepress, accessibilityReviews, accessibilityRemediations, fastWebView: new PdfFastWebViewService({ store, qpdf }) };
}

function createApplicationClose(automation, store) {
  let closeOperation = null;
  return () => {
    closeOperation ??= (async () => {
      const failures = [];
      try { await automation?.automationJs?.close(); } catch (error) { failures.push(error); }
      try { await automation?.batchPrint?.close(); } catch (error) { failures.push(error); }
      try { await automation?.preflightServer?.close(); } catch (error) { failures.push(error); }
      try { await automation?.webhooks?.close(); } catch (error) { failures.push(error); }
      try { await automation?.conditionalWorkflows?.close(); } catch (error) { failures.push(error); }
      try { await automation?.scheduledJobs?.close(); } catch (error) { failures.push(error); }
      try { await automation?.worker.close(); } catch (error) { failures.push(error); }
      try { await automation?.queue.close(); } catch (error) { failures.push(error); }
      try { await store.dispose(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Local application could not close cleanly.');
    })();
    return closeOperation;
  };
}

export async function createLocalApplication({ root, host = '127.0.0.1', port = 4173, token = randomBytes(32).toString('hex'), automationRoot = null, publisherTrustRoot = null, pluginPackageRoot = null, automationCapabilityAuthority = null, automationPrinterInventory = undefined, automationPrintAdapter = undefined, automationWebhookDestinationInventory = undefined, automationWebhookEventFactsResolver = undefined, automationWebhookDeliveryAdapter = undefined, automationPreflightEngine = undefined }, { PdfServiceClass, ComparisonServiceClass } = {}) {
  const sessionRoot = await mkdtemp(join(tmpdir(), 'platen-session-'));
  const trustedPublisherAuthority = await new PublisherTrustAuthority({ root: publisherTrustRoot ?? join(sessionRoot, 'publisher-trust') }).initialize();
  const trustedPublishers = trustedPublisherAuthority.store;
  const packageRoot = pluginPackageRoot ?? join(sessionRoot, 'plugin-packages');
  let pluginRuntimeAuthorities;
  const pluginPackages = new PluginPackageStore({
    root: packageRoot,
    trustedPublishers,
    activationTransition: (transition) => pluginRuntimeAuthorities.transition(transition),
  });
  pluginRuntimeAuthorities = new PluginRuntimeAuthorityRegistry({
    resolveActivation: (id) => pluginPackages.getActivation(id),
  });
  await pluginPackages.initialize();
  const store = await new DocumentStore({ root: sessionRoot }).initialize();
  const inputs = await new InputAssetStore({ root: sessionRoot }).initialize();
  const runner = createProcessLimiter({ concurrency: 4, maximumQueued: 24 });
  if (typeof PdfServiceClass !== 'function' || typeof ComparisonServiceClass !== 'function') throw new TypeError('createLocalApplication requires the composition-root service classes.');
  const engine = await createEngineRuntime({ root, sessionRoot, runner, store, inputs, PdfServiceClass });
  const optional = await createOptionalRuntime({ root, sessionRoot, runner, store, service: engine.service, adapter: engine.adapter });
  const documents = createDocumentServices({ store, inputs, adapter: engine.adapter, service: engine.service, registry: engine.registry });
  const workspaceState = new WorkspaceStateStore(store);
  const workflows = createWorkflowServices({ ...engine, ...optional, ...documents, store, inputs, workspaceState, pdfkitAdapter: optional.pdfkitAdapter, pdfkitInspections: optional.pdfkitInspections, ComparisonServiceClass });
  const staticHandler = createStaticHandler({ root, host, port });
  const handler = createAppHandler({
    staticHandler,
    store,
    service: engine.service,
    inputs,
    ...workflows,
    workspaceState,
    standardsValidations: optional.standardsValidations,
    ...documents,
    pdfkitInspections: optional.pdfkitInspections,
    pdfkitOutlineSplits: optional.pdfkitOutlineSplits,
    pdfkitMutations: optional.pdfkitMutations,
    pdfkitProtection: optional.pdfkitProtection,
    pdfkitSanitization: optional.pdfkitSanitization,
    pdfkitTextFieldWidget: optional.pdfkitTextFieldWidget,
    signatureTrustReady: Boolean(engine.signatureTrustAdapter),
    signingIdentityReady: Boolean(engine.signingIdentityAdapter),
    signingIdentityDirectory: engine.signingIdentityDirectory,
    certificateSignature: engine.certificateSignature,
    hiddenDataSanitization: documents.hiddenDataSanitization,
    taggedRemediation: documents.taggedRemediation,
    taggedRemediationReady: Boolean(documents.taggedRemediation),
    jpegImage: documents.jpegImageBroker,
    jpegImageReplacement: documents.jpegImageReplacementBroker,
    jpegImageReplacementReady: Boolean(documents.jpegImageReplacementBroker),
    jpegImageReady: Boolean(documents.jpegImageBroker),
    pageLabels: documents.pageLabels,
    pageLabelsReady: Boolean(documents.pageLabels),
    advancedSearch: documents.advancedSearch,
    advancedSearchReady: Boolean(documents.advancedSearch),
    specialistContent: documents.specialistContent,
    specialistContentReady: Boolean(documents.specialistContent),
    pluginSandboxStatus: engine.pluginSandboxStatus,
    pluginPackages,
    pluginRuntimeAuthorities,
    scannerDiscovery: optional.scannerDiscovery,
    scannerDiscoveryReady: Boolean(optional.scannerDiscovery),
    token,
    host,
    port,
  });
  const automation = await createLocalApplicationAutomation({ automationRoot, store, service: engine.service, fullPageRedaction: documents.fullPageRedaction, outputIntentService: Object.freeze({ assign: (documentId, request, options) => workflows.prepress.assignOutputIntent(documentId, request, options) }), automationCapabilityAuthority, automationPrinterInventory, automationPrintAdapter, automationWebhookDestinationInventory, automationWebhookEventFactsResolver, automationWebhookDeliveryAdapter, automationPreflightEngine });
  const close = createApplicationClose(automation, store);
  return Object.freeze({
    handler,
    store,
    service: engine.service,
    certificateSignature: engine.certificateSignature,
    signingIdentityDirectory: engine.signingIdentityDirectory,
    hiddenDataSanitization: documents.hiddenDataSanitization,
    taggedRemediation: documents.taggedRemediation,
    jpegImageInsertion: documents.jpegImageBroker,
    inputs,
    ...workflows,
    workspaceState,
    ...documents,
    ...optional,
    pluginSandboxStatus: engine.pluginSandboxStatus,
    pluginPackages,
    pluginRuntimeAuthorities,
    scannerDiscovery: optional.scannerDiscovery,
    scannerDiscoveryReady: Boolean(optional.scannerDiscovery),
    pdfkitHelper: optional.pdfkitHelper,
    signatureTrustHelper: engine.signatureTrustHelper,
    signingIdentityAdapter: engine.signingIdentityAdapter,
    signingIdentityHelper: engine.signingIdentityHelper,
    signingIdentityReady: Boolean(engine.signingIdentityAdapter),
    trustedPublishers: trustedPublisherAuthority,
    token,
    host,
    port,
    automation,
    professionalCapabilities: Object.freeze({
      deliver: deliverProfessionalCapability,
      list: listProfessionalHandlers,
    }),
    close,
  });
}
