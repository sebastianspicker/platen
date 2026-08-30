import { PdfIncrementalMetadataService } from '../application/pdf/pdf-incremental-metadata-service.mjs';
import { PdfIncrementalBleedBoxService } from '../application/pdf/pdf-incremental-bleed-box-service.mjs';
import { PdfIncrementalGoToLinkService } from '../application/pdf/pdf-incremental-goto-link-service.mjs';
import { PdfIncrementalBatchLinkService } from '../application/pdf/pdf-incremental-batch-link-service.mjs';
import { PdfIncrementalNamedDestinationService } from '../application/pdf/pdf-incremental-named-destination-service.mjs';
import { PdfPageVectorService } from '../application/pdf/pdf-page-vector-service.mjs';
import { PdfIncrementalPageTransitionService } from '../application/pdf/pdf-incremental-page-transition-service.mjs';
import { PdfPageTextService } from '../application/pdf/pdf-page-text-service.mjs';
import { PdfTextEditService } from '../application/pdf/pdf-text-edit-service.mjs';
import { PdfFullPageRedactionService } from '../application/pdf/pdf-full-page-redaction-service.mjs'; import { PdfRedactionOverlayLabelService } from '../application/pdf/pdf-redaction-overlay-label-service.mjs';
import { PdfPrinterMarksService } from '../application/pdf/pdf-printer-marks-service.mjs';
import { PdfPageBackgroundService } from '../application/pdf/pdf-page-background-service.mjs'; import { PdfPageWatermarkService } from '../application/pdf/pdf-page-watermark-service.mjs';
import { PdfPageHeaderFooterService } from '../application/pdf/pdf-page-header-footer-service.mjs';
import { PdfLayerDefaultsService } from '../application/pdf/pdf-layer-defaults-service.mjs';
import { PdfHiddenDataSanitizationService } from '../application/pdf/pdf-hidden-data-sanitization-service.mjs';
import { PdfAcroFormCheckboxService } from '../application/pdf/pdf-acroform-checkbox-service.mjs';
import { PdfAcroFormRadioService } from '../application/pdf/pdf-acroform-radio-service.mjs';
import { PdfAcroFormTextFieldService } from '../application/pdf/pdf-acroform-text-field-service.mjs';
import { PdfAcroFormBarcodeService } from '../application/pdf/pdf-acroform-barcode.mjs';
import { PdfFormJavaScriptInventoryService } from '../application/pdf/pdf-form-javascript-service.mjs'; import { PdfXfaInspectionService } from '../application/pdf/pdf-xfa-inspection-service.mjs';
import { PdfAcroFormChoiceService } from '../application/pdf/pdf-acroform-choice-service.mjs';
import { PdfAcroFormSignatureFieldService } from '../application/pdf/pdf-acroform-signature-field-service.mjs';
import { PdfAcroFormTabOrderTooltipService } from '../application/pdf/pdf-acroform-tab-order-tooltip-service.mjs'; import { PdfAcroFormFillSaveService } from '../application/pdf/pdf-acroform-fill-save-service.mjs'; import { PdfAcroFormValidationService } from '../application/pdf/pdf-acroform-validation-service.mjs'; import { PdfAcroFormDataExportService } from '../application/pdf/pdf-acroform-data-export-service.mjs';
import { PdfAccessibilityFormSemanticsService } from '../application/pdf/pdf-accessibility-form-semantics-service.mjs';
import { PdfAccessibilityTableSemanticsService } from '../application/pdf/pdf-accessibility-table-semantics-service.mjs';
import { PdfTextReflowService } from '../application/pdf/pdf-text-reflow-service.mjs';
import { PdfBatesNumberingService } from '../application/pdf/pdf-bates-numbering-service.mjs';
import { PdfTaggedRemediationService } from '../application/pdf/pdf-tagged-remediation-service.mjs';
import { PdfJpegImageService } from '../application/pdf/pdf-jpeg-image-service.mjs';
import { PdfJpegImageInputBroker } from '../application/pdf/pdf-jpeg-image-input-broker.mjs';
import { PdfJpegImageReplacementService } from '../application/pdf/pdf-jpeg-image-replacement-service.mjs';
import { PdfJpegImageReplacementInputBroker } from '../application/pdf/pdf-jpeg-image-replacement-input-broker.mjs';
import { PdfPageLabelsService } from '../application/pdf/pdf-page-labels-service.mjs';
import { PdfAdvancedSearchService } from '../application/pdf/pdf-advanced-search-service.mjs'; import { PdfSensitivePatternService } from '../application/pdf/pdf-sensitive-pattern-service.mjs';
import { PdfSpecialistContentService } from '../application/pdf/pdf-specialist-content-service.mjs';
import { AecMeasurementLegendService } from '../application/review/aec-measurement-legend-service.mjs';
import { PdfIncrementalAccessibilityMetadataService } from '../application/pdf/pdf-incremental-accessibility-metadata-service.mjs';
import { PdfJavaScriptRemovalService } from '../application/pdf/pdf-javascript-removal-service.mjs';
import { PdfAttachmentRemovalService } from '../application/pdf/pdf-attachment-removal-service.mjs';
import { PdfFileAudioAttachmentService } from '../application/pdf/pdf-file-audio-attachment-service.mjs';
import { PdfAccessibilityLinksBookmarksService } from '../application/pdf/pdf-accessibility-links-bookmarks-service.mjs';
import { PdfSpellcheckService } from '../application/pdf/pdf-spellcheck-service.mjs';
import { PdfAnnotationFlattenService } from '../application/pdf/pdf-annotation-flatten-service.mjs';
import { PdfOoxmlExportService } from '../application/pdf/pdf-ooxml-export.mjs';
import { OcrEditableOutputService, receiptFromOcrLayout } from '../application/ocr/ocr-editable-output.mjs';
import { HostError } from '../platform/runtime/host-error.mjs';

export function createDocumentServices({ store, inputs, adapter, service, registry }) {
  const jpegImage = new PdfJpegImageService({ store });
  const jpegImageBroker = new PdfJpegImageInputBroker({ inputs, service: jpegImage, store });
  const jpegImageReplacement = new PdfJpegImageReplacementService({ store, poppler: adapter });
  const jpegImageReplacementBroker = new PdfJpegImageReplacementInputBroker({ inputs, service: jpegImageReplacement, store });
  const pageLabels = new PdfPageLabelsService({ store });
  const advancedSearch = new PdfAdvancedSearchService({ store, inspection: service }); const sensitivePatterns = new PdfSensitivePatternService({ store, inspection: service });
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
    textEdit: new PdfTextEditService({ store, poppler: adapter }),
    fullPageRedaction: new PdfFullPageRedactionService({ store, poppler: adapter }), redactionOverlayLabels: new PdfRedactionOverlayLabelService({ store }),
    printerMarks: new PdfPrinterMarksService({ store }),
    pageBackground: new PdfPageBackgroundService({ store }),
    pageWatermark: new PdfPageWatermarkService({ store }),
    pageHeaderFooter: new PdfPageHeaderFooterService({ store }),
    layerDefaults: new PdfLayerDefaultsService({ store }),
    hiddenDataSanitization: new PdfHiddenDataSanitizationService({ store }),
    acroFormCheckbox: new PdfAcroFormCheckboxService({ store }),
    acroFormRadio: new PdfAcroFormRadioService({ store }),
    acroFormTextField,
    acroFormBarcode: new PdfAcroFormBarcodeService({ store }),
    formJavaScriptInventory: new PdfFormJavaScriptInventoryService({ store }), xfaInspection: new PdfXfaInspectionService({ store }),
    acroFormChoice: new PdfAcroFormChoiceService({ store }),
    acroFormSignatureField: new PdfAcroFormSignatureFieldService({ store }),
    acroFormTabOrderTooltip: new PdfAcroFormTabOrderTooltipService({ store }), acroFormFillSave: new PdfAcroFormFillSaveService({ store }), acroFormValidation: new PdfAcroFormValidationService({ store }), acroFormDataExport: new PdfAcroFormDataExportService({ store }),
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
    advancedSearch, sensitivePatterns,
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
