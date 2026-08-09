import { PlatenError } from './errors.js';
import { createAnnotationFlattenEndpoints } from './local-host-annotation-flatten-endpoints.js';
import { createAttachmentRemovalEndpoints } from './local-host-attachment-removal-endpoints.js';
import { createAecEndpoints } from './local-host-aec-endpoints.js';
import { createComparisonEndpoints } from './local-host-comparison-endpoints.js';
import { createCopyPageEndpoints } from './local-host-copy-page-endpoints.js';
import { createDocumentEndpoints } from './local-host-document-endpoints.js';
import { createIncrementalBleedBoxEndpoints } from './local-host-incremental-bleed-box-endpoints.js';
import { createIncrementalGoToLinkEndpoints } from './local-host-incremental-goto-link-endpoints.js';
import { createIncrementalNamedDestinationEndpoints } from './local-host-incremental-named-destination-endpoints.js';
import { createIncrementalAccessibilityMetadataEndpoints } from './local-host-incremental-accessibility-metadata-endpoints.js';
import { createIncrementalPageVectorEndpoints } from './local-host-incremental-page-vector-endpoints.js';
import { createIncrementalPageTransitionEndpoints } from './local-host-incremental-page-transition-endpoints.js';
import { createFullPageRedactionEndpoints } from './local-host-full-page-redaction-endpoints.js';
import { createPrinterMarksEndpoints } from './local-host-printer-marks-endpoints.js';
import { createPageBackgroundEndpoints } from './local-host-page-background-endpoints.js';
import { createLayerDefaultsEndpoints } from './local-host-layer-defaults-endpoints.js';
import { createSigningEndpoints } from './local-host-signing-endpoints.js';
import { createHiddenDataSanitizationEndpoints } from './local-host-hidden-data-sanitization-endpoints.js';
import { createAcroFormCheckboxEndpoints } from './local-host-acroform-checkbox-endpoints.js';
import { createAcroFormRadioEndpoints } from './local-host-acroform-radio-endpoints.js';
import { createAcroFormTextFieldEndpoints } from './local-host-acroform-text-field-endpoints.js';
import { createAcroFormChoiceEndpoints } from './local-host-acroform-choice-endpoints.js';
import { createAcroFormSignatureFieldEndpoints } from './local-host-acroform-signature-field-endpoints.js';
import { createAcroFormTabOrderTooltipEndpoints } from './local-host-acroform-tab-order-tooltip-endpoints.js';
import { createAcroFormFillValidationEndpoints } from './local-host-acroform-fill-validation-endpoints.js';
import { createAcroFormDataExportEndpoints } from './local-host-acroform-data-export-endpoints.js';
import { createBatesNumberingEndpoints } from './local-host-bates-numbering-endpoints.js';
import { createAecMeasurementLegendEndpoints } from './local-host-aec-measurement-legend-endpoints.js';
import { createTaggedRemediationEndpoints } from './local-host-tagged-remediation-endpoints.js';
import { createJpegImageEndpoints } from './local-host-jpeg-image-endpoints.js';
import { createJpegImageReplacementEndpoints } from './local-host-jpeg-image-replacement-endpoints.js';
import { createPageLabelsEndpoints } from './local-host-page-labels-endpoints.js';
import { createAdvancedSearchEndpoints } from './local-host-advanced-search-endpoints.js';
import { createSensitivePatternEndpoints } from './local-host-sensitive-pattern-endpoints.js';
import { createRedactionOverlayLabelEndpoints } from './local-host-redaction-overlay-label-endpoints.js';
import { createSpecialistContentEndpoints } from './local-host-specialist-content-endpoints.js';
import { createPageTextEndpoints } from './local-host-page-text-endpoints.js';
import { createTextReflowEndpoints } from './local-host-text-reflow-endpoints.js';
import { createR04ReviewEndpoints } from './local-host-r04-review-endpoints.js';
import { createIncrementalMetadataEndpoints } from './local-host-incremental-metadata-endpoints.js';
import { createJavaScriptRemovalEndpoints } from './local-host-javascript-removal-endpoints.js';
import { createOcrEndpoints } from './local-host-ocr-endpoints.js';
import { createPdfKitEndpoints } from './local-host-pdfkit-endpoints.js';
import { createPlatformEndpoints } from './local-host-platform-endpoints.js';
import { createPrepressEndpoints } from './local-host-prepress-endpoints.js';
import { createProjectEndpoints } from './local-host-project-endpoints.js';
import { createRasterReviewEndpoints } from './local-host-raster-review-endpoints.js';
import { createValidationEndpoints } from './local-host-validation-endpoints.js';
import { createScannerDiscoveryEndpoints } from './local-host-scanner-discovery-endpoints.js';
import { createScannerAcquisitionEndpoints } from './local-host-scanner-acquisition-endpoints.js';
import { createPluginPackageEndpoints } from './local-host-plugin-package-endpoints.js';
import { createFastWebViewEndpoints } from './local-host-fast-web-view-endpoints.js';
import { createOoxmlExportEndpoints } from './local-host-ooxml-export-endpoints.js';
import { createProfessionalAccessibilityEndpoints } from './local-host-professional-accessibility-endpoints.js';
import { createProfessionalPrintInspectionEndpoints } from './local-host-professional-print-inspection-endpoints.js';
import { createProfessionalPrintTransparencyEndpoints } from './local-host-professional-print-transparency-endpoints.js';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

async function decodeError(response) {
  try {
    const body = await response.json();
    return new PlatenError(body?.error?.code ?? 'LOCAL_HOST_ERROR', body?.error?.message ?? `Local host request failed (${response.status}).`);
  } catch {
    return new PlatenError('LOCAL_HOST_ERROR', `Local host request failed (${response.status}).`);
  }
}

/** Compatibility facade: local token bootstrap and authenticated transport only. */
export class LocalHostClient {
  #fetch;
  #token = null;
  #aec;
  #annotationFlatten;
  #attachmentRemoval;
  #comparison;
  #copyPage;
  #documents;
  #incrementalBleedBox;
  #incrementalGoToLink;
  #incrementalNamedDestination;
  #incrementalAccessibilityMetadata;
  #incrementalPageVector;
  #incrementalPageTransition;
  #fullPageRedaction; #printerMarks; #pageBackground;
  #layerDefaults; #signing; #hiddenDataSanitization;
  #acroFormCheckbox;
  #acroFormRadio;
  #acroFormTextField;
  #acroFormChoice;
  #acroFormSignatureField;
  #acroFormTabOrderTooltip; #acroFormFillValidation; #acroFormDataExport;
  #batesNumbering;
  #aecMeasurementLegend;
  #taggedRemediation;
  #jpegImage;
  #jpegImageReplacement;
  #pageLabels;
  #advancedSearch; #sensitivePatterns; #redactionOverlayLabels;
  #specialistContent;
  #pageText; #textReflow;
  #incrementalMetadata;
  #javascriptRemoval;
  #ocr;
  #pdfkit;
  #platform;
  #prepress;
  #projects;
  #rasterReview;
  #validation;
  #scannerDiscovery; #scannerAcquisition;
  #pluginPackages;
  #fastWebView; #ooxmlExport; #professionalAccessibility; #professionalPrintInspection; #professionalPrintTransparency; #reviewR04;
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('LocalHostClient requires fetch.');
    this.#fetch = fetchImpl;
    const transport = {
      json: (path, options) => this.#json(path, options),
      blob: (path, options) => this.#blob(path, options),
      text: (path, options) => this.#text(path, options),
      request: (path, options) => this.#request(path, options),
    };
    this.#aec = createAecEndpoints(transport);
    this.#annotationFlatten = createAnnotationFlattenEndpoints(transport);
    this.#attachmentRemoval = createAttachmentRemovalEndpoints(transport);
    this.#comparison = createComparisonEndpoints(transport);
    this.#copyPage = createCopyPageEndpoints(transport);
    this.#documents = createDocumentEndpoints(transport);
    this.#incrementalBleedBox = createIncrementalBleedBoxEndpoints(transport);
    this.#incrementalGoToLink = createIncrementalGoToLinkEndpoints(transport);
    this.#incrementalNamedDestination = createIncrementalNamedDestinationEndpoints(transport);
    this.#incrementalAccessibilityMetadata = createIncrementalAccessibilityMetadataEndpoints(transport);
    this.#incrementalPageVector = createIncrementalPageVectorEndpoints(transport);
    this.#incrementalPageTransition = createIncrementalPageTransitionEndpoints(transport);
    this.#fullPageRedaction = createFullPageRedactionEndpoints(transport); this.#printerMarks = createPrinterMarksEndpoints(transport); this.#pageBackground = createPageBackgroundEndpoints(transport);
    this.#layerDefaults = createLayerDefaultsEndpoints(transport);
    this.#signing = createSigningEndpoints(transport);
    this.#hiddenDataSanitization = createHiddenDataSanitizationEndpoints(transport);
    this.#acroFormCheckbox = createAcroFormCheckboxEndpoints(transport);
    this.#acroFormRadio = createAcroFormRadioEndpoints(transport);
    this.#acroFormTextField = createAcroFormTextFieldEndpoints(transport);
    this.#acroFormChoice = createAcroFormChoiceEndpoints(transport);
    this.#acroFormSignatureField = createAcroFormSignatureFieldEndpoints(transport);
    this.#acroFormTabOrderTooltip = createAcroFormTabOrderTooltipEndpoints(transport); this.#acroFormFillValidation = createAcroFormFillValidationEndpoints(transport); this.#acroFormDataExport = createAcroFormDataExportEndpoints(transport);
    this.#batesNumbering = createBatesNumberingEndpoints(transport);
    this.#aecMeasurementLegend = createAecMeasurementLegendEndpoints(transport);
    this.#taggedRemediation = createTaggedRemediationEndpoints(transport);
    this.#jpegImage = createJpegImageEndpoints(transport);
    this.#jpegImageReplacement = createJpegImageReplacementEndpoints(transport);
    this.#pageLabels = createPageLabelsEndpoints(transport);
    this.#advancedSearch = createAdvancedSearchEndpoints(transport);
    this.#sensitivePatterns = createSensitivePatternEndpoints(transport); this.#redactionOverlayLabels = createRedactionOverlayLabelEndpoints(transport);
    this.#specialistContent = createSpecialistContentEndpoints(transport);
    this.#pageText = createPageTextEndpoints(transport); this.#textReflow = createTextReflowEndpoints(transport);
    this.#incrementalMetadata = createIncrementalMetadataEndpoints(transport);
    this.#javascriptRemoval = createJavaScriptRemovalEndpoints(transport);
    this.#ocr = createOcrEndpoints(transport);
    this.#pdfkit = createPdfKitEndpoints(transport);
    this.#platform = createPlatformEndpoints(transport);
    this.#prepress = createPrepressEndpoints(transport);
    this.#projects = createProjectEndpoints(transport);
    this.#rasterReview = createRasterReviewEndpoints(transport);
    this.#validation = createValidationEndpoints(transport);
    this.#scannerDiscovery = createScannerDiscoveryEndpoints(transport); this.#scannerAcquisition = createScannerAcquisitionEndpoints(transport);
    this.#pluginPackages = createPluginPackageEndpoints(transport);
    this.#fastWebView = createFastWebViewEndpoints(transport);
    this.#ooxmlExport = createOoxmlExportEndpoints(transport);
    this.#professionalAccessibility = createProfessionalAccessibilityEndpoints(transport);
    this.#professionalPrintInspection = createProfessionalPrintInspectionEndpoints(transport);
    this.#professionalPrintTransparency = createProfessionalPrintTransparencyEndpoints(transport); this.#reviewR04 = createR04ReviewEndpoints(transport);
  }

  get connected() { return Boolean(this.#token); }

  async bootstrap() {
    const response = await this.#fetch('/api/bootstrap', { method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw await decodeError(response);
    const body = await response.json();
    if (!TOKEN_PATTERN.test(body?.sessionToken ?? '')) throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid session token.');
    this.#token = body.sessionToken;
    return Object.freeze({ host: body.host, engines: Object.freeze(body.engines ?? []) });
  }

  upload(...args) { return this.#documents.upload(...args); }
  uploadInput(...args) { return this.#documents.uploadInput(...args); }
  createBlank(...args) { return this.#documents.createBlank(...args); }
  createText(...args) { return this.#documents.createText(...args); }
  convertInput(...args) { return this.#documents.convertInput(...args); }
  inspect(...args) { return this.#documents.inspect(...args); }
  inspectStructure(...args) { return this.#documents.inspectStructure(...args); }
  workspace(...args) { return this.#documents.workspace(...args); }
  mutateWorkspace(...args) { return this.#documents.mutateWorkspace(...args); }
  replaceWorkspace(...args) { return this.#documents.replaceWorkspace(...args); }
  text(...args) { return this.#documents.text(...args); }
  fonts(...args) { return this.#documents.fonts(...args); }
  images(...args) { return this.#documents.images(...args); }
  replaceJpegImage(...args) { return this.#jpegImageReplacement.replaceJpegImage(...args); }
  attachments(...args) { return this.#documents.attachments(...args); }
  signatures(...args) { return this.#documents.signatures(...args); }
  ocrLanguages(...args) { return this.#documents.ocrLanguages(...args); }
  domainOperations(...args) { return this.#documents.domainOperations(...args); }
  executeDomain(...args) { return this.#documents.executeDomain(...args); }
  thumbnail(...args) { return this.#documents.thumbnail(...args); }
  cropBoxRaster(...args) { return this.#documents.cropBoxRaster(...args); }
  cropBoxSnapshot(...args) { return this.#documents.cropBoxSnapshot(...args); }
  extractPages(...args) { return this.#documents.extractPages(...args); }
  arrangePages(...args) { return this.#documents.arrangePages(...args); }
  deletePages(...args) { return this.#documents.deletePages(...args); }
  mergeDocuments(...args) { return this.#documents.mergeDocuments(...args); }
  splitDocument(...args) { return this.#documents.splitDocument(...args); }
  splitByPageCount(...args) { return this.#documents.splitByPageCount(...args); }
  splitByVerifiedTopLevelOutline(...args) { return this.#documents.splitByVerifiedTopLevelOutline(...args); }
  duplicatePages(...args) { return this.#documents.duplicatePages(...args); }
  reversePages(...args) { return this.#documents.reversePages(...args); }
  interleaveDocuments(...args) { return this.#documents.interleaveDocuments(...args); }
  insertDocument(...args) { return this.#documents.insertDocument(...args); }
  replacePages(...args) { return this.#documents.replacePages(...args); }
  copyPageBetweenDocuments(...args) { return this.#copyPage.copyPageBetweenDocuments(...args); }
  artifact(...args) { return this.#documents.artifact(...args); }
  deleteArtifact(...args) { return this.#documents.deleteArtifact(...args); }
  documentSource(...args) { return this.#documents.documentSource(...args); }
  rewriteDocument(...args) { return this.#documents.rewriteDocument(...args); }
  deleteInput(...args) { return this.#documents.deleteInput(...args); }
  deleteDocument(...args) { return this.#documents.deleteDocument(...args); }

  ocrDocument(...args) { return this.#ocr.ocrDocument(...args); }
  analyzeOcrLayout(...args) { return this.#ocr.analyzeOcrLayout(...args); }
  ocrBatch(...args) { return this.#ocr.ocrBatch(...args); }

  runPdfKitInspection(...args) { return this.#pdfkit.runPdfKitInspection(...args); }
  runAnnotationFlatten(...args) {
    return this.#annotationFlatten.runAnnotationFlatten(...args);
  }
  runAttachmentRemoval(...args) {
    return this.#attachmentRemoval.runAttachmentRemoval(...args);
  }
  runIncrementalBleedBox(...args) {
    return this.#incrementalBleedBox.runIncrementalBleedBox(...args);
  }
  runIncrementalGoToLink(...args) {
    return this.#incrementalGoToLink.runIncrementalGoToLink(...args);
  }
  runIncrementalNamedDestination(...args) {
    return this.#incrementalNamedDestination.runIncrementalNamedDestination(...args);
  }
  runIncrementalPageVector(...args) {
    return this.#incrementalPageVector.runIncrementalPageVector(...args);
  }
  runIncrementalPageTransition(...args) {
    return this.#incrementalPageTransition.runIncrementalPageTransition(...args);
  }
  runFullPageRedaction(...args) { return this.#fullPageRedaction.runFullPageRedaction(...args); }

  runFullPageRedactionBatch(...args) {
    return this.#fullPageRedaction.runFullPageRedactionBatch(...args);
  }

  createPrinterMarks(...args) {
    return this.#printerMarks.createPrinterMarks(...args);
  }
  createPageBackground(...args) {
    return this.#pageBackground.createPageBackground(...args);
  }
  runLayerDefaults(...args) {
    return this.#layerDefaults.runLayerDefaults(...args);
  }
  listSigningIdentities(...args) { return this.#signing.listSigningIdentities(...args); } signCertificate(...args) { return this.#signing.signCertificate(...args); }
  validateCertificateSignatures(...args) { return this.#signing.validateCertificateSignatures(...args); } recordElectronicSigningIntent(...args) { return this.#signing.recordElectronicSigningIntent(...args); }
  sanitizeHiddenData(...args) { return this.#hiddenDataSanitization.sanitizeHiddenData(...args); }
  addAcroFormCheckbox(...args) { return this.#acroFormCheckbox.addAcroFormCheckbox(...args); }
  addAcroFormRadio(...args) { return this.#acroFormRadio.addAcroFormRadio(...args); }
  addAcroFormTextField(...args) { return this.#acroFormTextField.addAcroFormTextField(...args); }
  addAcroFormChoice(...args) { return this.#acroFormChoice.addAcroFormChoice(...args); }
  addAcroFormSignatureField(...args) { return this.#acroFormSignatureField.addAcroFormSignatureField(...args); }
  updateAcroFormTabOrderTooltip(...args) { return this.#acroFormTabOrderTooltip.updateAcroFormTabOrderTooltip(...args); } fillAndSaveAcroForm(...args) { return this.#acroFormFillValidation.fillAndSaveAcroForm(...args); } validateAcroFormValues(...args) { return this.#acroFormFillValidation.validateAcroFormValues(...args); } exportAcroFormData(...args) { return this.#acroFormDataExport.exportAcroFormData(...args); }
  runBatesNumbering(...args) { return this.#batesNumbering.runBatesNumbering(...args); }
  generateAecMeasurementLegend(...args) { return this.#aecMeasurementLegend.generateAecMeasurementLegend(...args); }
  updateTaggedRemediation(...args) { return this.#taggedRemediation.updateTaggedRemediation(...args); }
  insertJpegImage(...args) { return this.#jpegImage.insertJpegImage(...args); }
  createPageLabels(...args) { return this.#pageLabels.createPageLabels(...args); }
  searchAdvancedText(...args) { return this.#advancedSearch.searchAdvancedText(...args); }
  findSensitivePatterns(...args) { return this.#sensitivePatterns.findSensitivePatterns(...args); } applyRedactionOverlayLabel(...args) { return this.#redactionOverlayLabels.applyRedactionOverlayLabel(...args); }
  inspectSpecialistContent(...args) { return this.#specialistContent.inspectSpecialistContent(...args); }
  runPageText(...args) { return this.#pageText.runPageText(...args); }
  reflowText(...args) { return this.#textReflow.reflowText(...args); }
  addFileAudioAttachment(...args) { return this.#reviewR04.addFileAudioAttachment(...args); }
  createReviewMeasurement(...args) { return this.#reviewR04.createReviewMeasurement(...args); } importReviewAnnotationXfdf(...args) { return this.#reviewR04.importReviewAnnotationXfdf(...args); }
  exportCommentsToOffice(...args) { return this.#reviewR04.exportCommentsToOffice(...args); }
  inspectFormJavaScriptInventory(...args) { return this.#reviewR04.inspectFormJavaScriptInventory(...args); } inspectXfaPresence(...args) { return this.#reviewR04.inspectXfaPresence(...args); }
  generateReviewNotifications(...args) { return this.#reviewR04.generateReviewNotifications(...args); } markReviewNotificationRead(...args) { return this.#reviewR04.markReviewNotificationRead(...args); }
  exportReviewSharedExchange(...args) { return this.#reviewR04.exportReviewSharedExchange(...args); } importReviewSharedExchange(...args) { return this.#reviewR04.importReviewSharedExchange(...args); } setReviewSidecarStatus(...args) { return this.#reviewR04.setReviewSidecarStatus(...args); } inspectReviewSidecar(...args) { return this.#reviewR04.inspectReviewSidecar(...args); }
  runIncrementalAccessibilityMetadata(...args) {
    return this.#incrementalAccessibilityMetadata.runIncrementalAccessibilityMetadata(...args);
  }
  runIncrementalMetadata(...args) {
    return this.#incrementalMetadata.runIncrementalMetadata(...args);
  }
  runJavaScriptRemoval(...args) {
    return this.#javascriptRemoval.runJavaScriptRemoval(...args);
  }
  runFastWebView(...args) { return this.#fastWebView.runFastWebView(...args); }
  exportOoxml(...args) { return this.#ooxmlExport.exportOoxml(...args); }
  repairAccessibilityFormSemantics(...args) { return this.#professionalAccessibility.repairAccessibilityFormSemantics(...args); }
  repairAccessibilityTableSemantics(...args) { return this.#professionalAccessibility.repairAccessibilityTableSemantics(...args); }
  repairAccessibilityLinksBookmarks(...args) { return this.#professionalAccessibility.repairAccessibilityLinksBookmarks(...args); }
  inspectAccessibilityTableSemanticsLocators(...args) { return this.#professionalAccessibility.inspectAccessibilityTableSemanticsLocators(...args); }
  inspectAccessibilityLinksBookmarksLocators(...args) { return this.#professionalAccessibility.inspectAccessibilityLinksBookmarksLocators(...args); }
  inspectPrintFonts(...args) { return this.#professionalPrintInspection.inspectPrintFonts(...args); }
  inspectPrintImages(...args) { return this.#professionalPrintInspection.inspectPrintImages(...args); } flattenPrintTransparency(...args) { return this.#professionalPrintTransparency.flattenPrintTransparency(...args); }
  exportWord(documentId, sourceSha256, options = {}) { return this.exportOoxml(documentId, { profile: 'local-pdf-ooxml-export-v1', sourceSha256, format: 'word' }, options); }
  exportExcel(documentId, sourceSha256, options = {}) { return this.exportOoxml(documentId, { profile: 'local-pdf-ooxml-export-v1', sourceSha256, format: 'excel' }, options); }
  exportPowerpoint(documentId, sourceSha256, options = {}) { return this.exportOoxml(documentId, { profile: 'local-pdf-ooxml-export-v1', sourceSha256, format: 'powerpoint' }, options); }
  runPdfKitMutation(...args) { return this.#pdfkit.runPdfKitMutation(...args); }
  runPdfKitTargetedMutation(...args) { return this.#pdfkit.runPdfKitTargetedMutation(...args); }
  addPdfKitTextFieldWidget(...args) { return this.#pdfkit.addPdfKitTextFieldWidget(...args); }
  runPdfKitLocalGoToMutation(...args) { return this.#pdfkit.runPdfKitLocalGoToMutation(...args); }
  runPdfKitLocalGoToRemovalMutation(...args) { return this.#pdfkit.runPdfKitLocalGoToRemovalMutation(...args); }
  runPdfKitOutlineMutation(...args) { return this.#pdfkit.runPdfKitOutlineMutation(...args); }
  runPdfKitOutlineRemovalMutation(...args) { return this.#pdfkit.runPdfKitOutlineRemovalMutation(...args); }
  runPdfKitOutlineRenameMutation(...args) { return this.#pdfkit.runPdfKitOutlineRenameMutation(...args); }
  runPdfKitLineAnnotationMutation(...args) { return this.#pdfkit.runPdfKitLineAnnotationMutation(...args); }
  runPdfKitInkAnnotationMutation(...args) { return this.#pdfkit.runPdfKitInkAnnotationMutation(...args); }
  protectPdfKit(...args) { return this.#pdfkit.protectPdfKit(...args); }
  removePdfKitProtection(...args) { return this.#pdfkit.removePdfKitProtection(...args); }
  sanitizePdfKitMetadata(...args) { return this.#pdfkit.sanitizePdfKitMetadata(...args); }

  runPluginSandboxProbe(...args) { return this.#platform.runPluginSandboxProbe(...args); }
  discoverScanners(...args) { return this.#scannerDiscovery.discoverScanners(...args); } acquireScanner(...args) { return this.#scannerAcquisition.acquireScanner(...args); }
  listPluginPackages(...args) { return this.#pluginPackages.listPluginPackages(...args); }
  listActivePluginCapabilities(...args) { return this.#pluginPackages.listActivePluginCapabilities(...args); }
  installPluginPackage(...args) { return this.#pluginPackages.installPluginPackage(...args); }
  activatePluginPackage(...args) { return this.#pluginPackages.activatePluginPackage(...args); }
  rollbackPluginPackage(...args) { return this.#pluginPackages.rollbackPluginPackage(...args); }

  calibrateAec(...args) { return this.#aec.calibrateAec(...args); }
  measureAec(...args) { return this.#aec.measureAec(...args); }
  materializeAec(...args) { return this.#aec.materializeAec(...args); }
  exportProjectBundle(...args) { return this.#projects.exportProjectBundle(...args); }
  importProjectBundle(...args) { return this.#projects.importProjectBundle(...args); }
  exportPortableProjectBundle(...args) { return this.#projects.exportPortableProjectBundle(...args); }
  importPortableProjectBundle(...args) { return this.#projects.importPortableProjectBundle(...args); }
  mutateRaster(...args) { return this.#rasterReview.mutateRaster(...args); }
  createRedactionPlan(...args) { return this.#rasterReview.createRedactionPlan(...args); }
  applyRedactionPlan(...args) { return this.#rasterReview.applyRedactionPlan(...args); }
  exportRedactionPlanReport(...args) { return this.#rasterReview.exportRedactionPlanReport(...args); }
  compareDocuments(...args) { return this.#comparison.compareDocuments(...args); }
  compareBatch(...args) { return this.#comparison.compareBatch(...args); }
  createComparisonPackage(...args) { return this.#comparison.createComparisonPackage(...args); }
  runPrepress(...args) { return this.#prepress.runPrepress(...args); }
  convertToCmyk(...args) { return this.#prepress.convertToCmyk(...args); }
  createImposition(...args) { return this.#prepress.createImposition(...args); }
  runProductionValidation(...args) { return this.#prepress.runProductionValidation(...args); }
  assignOutputIntent(...args) { return this.#prepress.assignOutputIntent(...args); }
  runAccessibilityReview(...args) { return this.#validation.runAccessibilityReview(...args); }
  runStandardsValidation(...args) { return this.#validation.runStandardsValidation(...args); }
  createAccessibilityProposal(...args) { return this.#validation.createAccessibilityProposal(...args); }
  exportAccessibilityProposal(...args) { return this.#validation.exportAccessibilityProposal(...args); }

  async #json(path, options = {}) { return (await this.#request(path, options)).json(); }
  async #blob(path, options = {}) { return (await this.#request(path, options)).blob(); }
  async #text(path, options = {}) { return (await this.#request(path, options)).text(); }
  async #request(path, options = {}) {
    if (!this.#token) throw new PlatenError('LOCAL_HOST_DISCONNECTED', 'The local PDF host is not connected.');
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new TypeError('Local host paths must start with /api/.');
    const response = await this.#fetch(path, { ...options, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { ...options.headers, 'X-Platen-Token': this.#token } });
    if (!response.ok) throw await decodeError(response);
    return response;
  }
}

export { decodeError };
