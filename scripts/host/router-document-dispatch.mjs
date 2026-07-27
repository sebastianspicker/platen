export async function handleDocumentRoutes(options) {
  const { pathname, request, response, url, processing, store, workspaceState, routes, limits } = options;
  const documentPattern = new RegExp([
    "^\\/api\\/documents\\/([^/]+)(?:\\/(workspace|domain|aec-calibration|aec-measurement|aec-materialization|project-bundle|portable-project-bundle|source|inspection|structure|text|thumbna",
    "il|cropbox-raster|cropbox-snapshot|fonts|images|attachments|signatures|extract|arrange|merge|split|split-rule|split-outline|duplicate|reverse|interleave|insert|replace|copy-page|oc",
    "r|ocr-analysis|rewrite|mutation|compare|prepress\\/output-intent|prepress|redaction-plan|redaction-application|redaction-report|accessibility-review|accessibility-proposal|standards",
    "-validation|pdfkit-inspection|pdfkit-mutation|pdfkit-text-field-widget|pdfkit-protection|pdfkit-protection-removal|sanitization|sanitize-hidden-data|acroform-checkbox|acroform-radi",
    "o|acroform-text-field|acroform-choice|acroform-signature-field|bates-numbering|tagged-remediation|insert-jpeg|replace-jpeg|page-labels|advanced-search|incremental-metadata|incremental-bleed-box|incremental-goto-link|incremental-named-destination|incremental-page-vector|incremental-page-transition|",
    "page-text|full-page-redaction|full-page-redaction-batch|printer-marks|page-background|specialist-content|layer-defaults|certificate-sign|incremental-accessibility-metadata|javascript-removal|attachment-removal|annotation-flatten|aec-measurement-legend|fast-web-view|export-ooxml))?$"
  ].join(''));
  const documentMatch = pathname.match(documentPattern);
  if (!documentMatch) return false;
  const [, documentId, operation] = documentMatch;
  const shared = { ...options, documentId, operation };
  if (await routes.workspace({ ...shared, ...options })) return true;
  if (await routes.workflow({ ...shared, ...options })) return true;
  if (await routes.incrementalMetadata({ ...shared, incrementalMetadata: options.incrementalMetadata, bodyLimit: limits.incrementalMetadata })) return true;
  if (await routes.incrementalBleedBox({ ...shared, incrementalBleedBox: options.incrementalBleedBox, bodyLimit: limits.incrementalBleedBox })) return true;
  if (await routes.incrementalGoToLink({ ...shared, incrementalGoToLink: options.incrementalGoToLink, bodyLimit: limits.incrementalGotoLink })) return true;
  if (await routes.incrementalNamedDestination({ ...shared, incrementalNamedDestination: options.incrementalNamedDestination, bodyLimit: limits.incrementalNamedDestination })) return true;
  if (await routes.incrementalPageVector({ ...shared, incrementalPageVector: options.incrementalPageVector, bodyLimit: limits.incrementalPageVector })) return true;
  if (await routes.incrementalPageTransition?.({ ...shared, incrementalPageTransition: options.incrementalPageTransition, bodyLimit: limits.incrementalPageTransition })) return true;
  if (await routes.pageText({ ...shared, pageText: options.pageText, bodyLimit: limits.pageText })) return true;
  if (await routes.ooxmlExport?.({ ...shared, ooxmlExport: options.ooxmlExport, processing, bodyLimit: limits.ooxmlExport })) return true;
  if (await routes.fullPageRedaction({ ...shared, fullPageRedaction: options.fullPageRedaction, bodyLimit: limits.fullPageRedaction })) return true;
  if (await routes.fullPageRedactionBatch({ ...shared, fullPageRedaction: options.fullPageRedaction, bodyLimit: limits.fullPageRedactionBatch })) return true;
  if (await routes.printerMarks({ ...shared, printerMarks: options.printerMarks, bodyLimit: limits.printerMarks })) return true;
  if (await routes.pageBackground?.({ ...shared, pageBackground: options.pageBackground, bodyLimit: limits.pageBackground })) return true;
  if (await routes.specialistContent({ ...shared, specialistContent: options.specialistContent, specialistContentReady: options.specialistContentReady, bodyLimit: limits.specialistContent })) return true;
  if (await routes.layerDefaults({ ...shared, layerDefaults: options.layerDefaults, bodyLimit: limits.layerDefaults })) return true;
  if (await routes.certificateSign({ ...shared, certificateSignature: options.certificateSignature, signingIdentityReady: options.signingIdentityReady, bodyLimit: limits.certificateSignature })) return true;
  if (await routes.hiddenDataSanitization({ ...shared, hiddenDataSanitization: options.hiddenDataSanitization, bodyLimit: limits.hiddenDataSanitization })) return true;
  if (await routes.acroFormCheckbox({ ...shared, acroFormCheckbox: options.acroFormCheckbox })) return true;
  if (await routes.acroFormRadio({ ...shared, acroFormRadio: options.acroFormRadio })) return true;
  if (await routes.acroFormTextField?.({ ...shared, acroFormTextField: options.acroFormTextField })) return true;
  if (await routes.acroFormChoice?.({ ...shared, acroFormChoice: options.acroFormChoice })) return true;
  if (await routes.acroFormSignatureField?.({ ...shared, acroFormSignatureField: options.acroFormSignatureField })) return true;
  if (await routes.batesNumbering?.({ ...shared, batesNumbering: options.batesNumbering, bodyLimit: limits.batesNumbering })) return true;
  if (await routes.aecMeasurementLegend?.({ ...shared, aecMeasurementLegend: options.aecMeasurementLegend })) return true;
  if (await routes.taggedRemediation({ ...shared, taggedRemediation: options.taggedRemediation, taggedRemediationReady: options.taggedRemediationReady, bodyLimit: limits.taggedRemediation })) return true;
  if (await routes.jpegImage({ ...shared, jpegImage: options.jpegImage, jpegImageReady: options.jpegImageReady, bodyLimit: limits.jpegImage })) return true;
  if (await routes.jpegImageReplacement?.({ ...shared, jpegImageReplacement: options.jpegImageReplacement, jpegImageReplacementReady: options.jpegImageReplacementReady, bodyLimit: limits.jpegImageReplacement })) return true;
  if (await routes.pageLabels({ ...shared, pageLabels: options.pageLabels, pageLabelsReady: options.pageLabelsReady, bodyLimit: limits.pageLabels })) return true;
  if (await routes.advancedSearch({ ...shared, advancedSearch: options.advancedSearch, advancedSearchReady: options.advancedSearchReady, bodyLimit: limits.advancedSearch })) return true;
  if (await routes.incrementalAccessibilityMetadata({ ...shared, incrementalAccessibilityMetadata: options.incrementalAccessibilityMetadata, bodyLimit: limits.incrementalAccessibilityMetadata })) return true;
  if (await routes.removal({ ...shared, javascriptRemoval: options.javascriptRemoval, attachmentRemoval: options.attachmentRemoval, annotationFlatten: options.annotationFlatten })) return true;
  if (await routes.fastWebView?.({ ...shared, fastWebView: options.fastWebView, bodyLimit: limits.fastWebView })) return true;
  if (await routes.copyPage({ ...shared, bodyLimit: limits.copyPage })) return true;
  if (await routes.pdfkit({ ...shared, bodyLimit: limits.pdfkit, mutationBodyLimit: limits.pdfkitMutation, protectionBodyLimit: limits.pdfkitProtection })) return true;
  if (await routes.documentService({ ...shared })) return true;
  return false;
}
