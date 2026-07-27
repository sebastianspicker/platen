import { isAllowedHost } from '../server-lib.mjs';
import { asHostError, HostError } from './host-error.mjs';
import {
  decodeDisplayName, empty, hasToken, json, method, parsePositiveInteger,
  parseSnapshotRegion, readBytes, readJson, requireContentType,
  requireLocalFetchMetadata, requireSameOrigin, sendArtifact, sendPortableProject, write,
} from './http-boundary.mjs';
import { handleArtifactRoute } from './routes/artifact-routes.mjs';
import { handleAnnotationFlattenRoute } from './routes/annotation-flatten-routes.mjs';
import { handleBootstrapRoute } from './routes/bootstrap-routes.mjs';
import { handleConversionRoute } from './routes/conversion-routes.mjs';
import { handleDocumentServiceRoute } from './routes/document-service-routes.mjs';
import { handleIncrementalMetadataRoute } from './routes/incremental-metadata-routes.mjs';
import { handleIncrementalBleedBoxRoute } from './routes/incremental-bleed-box-routes.mjs';
import { handleIncrementalGoToLinkRoute } from './routes/incremental-goto-link-routes.mjs';
import { handleIncrementalNamedDestinationRoute } from './routes/incremental-named-destination-routes.mjs';
import { handleIncrementalPageVectorRoute } from './routes/incremental-page-vector-routes.mjs';
import { handleIncrementalPageTransitionRoute } from './routes/incremental-page-transition-routes.mjs';
import { handlePageTextRoute } from './routes/page-text-routes.mjs';
import { handleFullPageRedactionBatchRoute, handleFullPageRedactionRoute } from './routes/full-page-redaction-routes.mjs';
import { handlePrinterMarksRoute } from './routes/printer-marks-routes.mjs';
import { handlePageBackgroundRoute } from './routes/page-background-routes.mjs';
import { handleSpecialistContentRoute } from './routes/specialist-content-routes.mjs';
import { handleCertificateSignRoute, handleSigningIdentityListRoute } from './routes/signing-identity-routes.mjs';
import { handleDocumentRoutes } from './router-document-dispatch.mjs';
import { handleLayerDefaultsRoute } from './routes/layer-defaults-routes.mjs';
import { handleHiddenDataSanitizationRoute } from './routes/hidden-data-sanitization-routes.mjs';
import { handleAcroFormCheckboxRoute, handleAcroFormRadioRoute, handleAcroFormTextFieldRoute, handleAcroFormChoiceRoute, handleAcroFormSignatureFieldRoute } from './routes/acroform-routes.mjs';
import { handleAecMeasurementLegendRoute } from './routes/aec-measurement-legend-routes.mjs';
import { handleTaggedRemediationRoute } from './routes/tagged-remediation-routes.mjs';
import { handleJpegImageRoute } from './routes/jpeg-image-routes.mjs';
import { handleJpegImageReplacementRoute } from './routes/jpeg-image-replacement-routes.mjs';
import { handlePageLabelsRoute } from './routes/page-labels-routes.mjs';
import { handleAdvancedSearchRoute } from './routes/advanced-search-routes.mjs';
import { handleIncrementalAccessibilityMetadataRoute } from './routes/incremental-accessibility-metadata-routes.mjs';
import { handleJavaScriptRemovalRoute } from './routes/javascript-removal-routes.mjs';
import { handleAttachmentRemovalRoute } from './routes/attachment-removal-routes.mjs';
import { handleOcrRoute } from './routes/ocr-routes.mjs';
import { handlePdfkitRoute } from './routes/pdfkit-routes.mjs';
import { handlePluginPlatformRoute } from './routes/plugin-platform-routes.mjs';
import { handleDomainCatalogRoute, handlePortableProjectImportRoute, handleWorkspaceRoute } from './routes/workspace-routes.mjs';
import { handleComparisonBatchRoute, handleWorkflowRoute } from './routes/workflow-routes.mjs';
import { handleCopyPageRoute } from './routes/copy-page-routes.mjs';
import { handleScannerDiscoveryRoute } from './routes/scanner-discovery-routes.mjs';
import { handleBatesNumberingRoute } from './routes/bates-numbering-routes.mjs';
import { handleFastWebViewRoute } from './routes/fast-web-view-routes.mjs';
import { handleOoxmlExportRoute } from './routes/ooxml-export-routes.mjs';
import {
  normalizeOcrDocumentRequest, normalizeOcrLayoutRequest,
  validateOcrDocumentResult, validateOcrLayoutResult,
} from '../../src/core/ocr-contract.js';

const PDFKIT_MUTATION_JSON_BODY_LIMIT = 8_192;
const PDFKIT_TEXT_FIELD_WIDGET_JSON_BODY_LIMIT = 4_096;
const PDFKIT_PROTECTION_JSON_BODY_LIMIT = 2_048;
const INCREMENTAL_METADATA_JSON_BODY_LIMIT = 8_192;
const INCREMENTAL_BLEED_BOX_JSON_BODY_LIMIT = 2_048;
const INCREMENTAL_GOTO_LINK_JSON_BODY_LIMIT = 2_048;
const INCREMENTAL_NAMED_DESTINATION_JSON_BODY_LIMIT = 2_048;
const INCREMENTAL_PAGE_VECTOR_JSON_BODY_LIMIT = 2_048;
const INCREMENTAL_PAGE_TRANSITION_JSON_BODY_LIMIT = 2_048;
const PAGE_TEXT_JSON_BODY_LIMIT = 2_048;
const FULL_PAGE_REDACTION_JSON_BODY_LIMIT = 1_024;
const FULL_PAGE_REDACTION_BATCH_JSON_BODY_LIMIT = 2_048;
const PRINTER_MARKS_JSON_BODY_LIMIT = 4_096;
const PAGE_BACKGROUND_JSON_BODY_LIMIT = 4_096;
const SPECIALIST_CONTENT_JSON_BODY_LIMIT = 2_048;
const LAYER_DEFAULTS_JSON_BODY_LIMIT = 4_096;
const CERTIFICATE_SIGNATURE_JSON_BODY_LIMIT = 4_096;
const HIDDEN_DATA_SANITIZATION_JSON_BODY_LIMIT = 1_024;
const INCREMENTAL_ACCESSIBILITY_METADATA_JSON_BODY_LIMIT = 2_048;
const JAVASCRIPT_REMOVAL_JSON_BODY_LIMIT = 2_048;
const ATTACHMENT_REMOVAL_JSON_BODY_LIMIT = 1_024;
const COPY_PAGE_JSON_BODY_LIMIT = 2_048;
const ANNOTATION_FLATTEN_JSON_BODY_LIMIT = 2_048;
const FAST_WEB_VIEW_JSON_BODY_LIMIT = 2_048;
const OOXML_EXPORT_JSON_BODY_LIMIT = 2_048;

function exactJsonObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function sanitizedEngineAvailability(records) {
  return records.map(({ name, version = null, available, reason = null }) => ({ name, version, available, reason }));
}

async function normalizedOcrOptions(service, processing, body, normalizer, code) {
  const languages = await service.ocrLanguages(processing);
  try {
    return normalizer(body, languages);
  } catch (error) {
    if (error?.code === 'OCR_CONTRACT_INVALID') throw new HostError(code, error.message, 400, { cause: error });
    throw error;
  }
}

function checkedOcrResult(value, validator) {
  try {
    return validator(value);
  } catch (error) {
    if (error?.code === 'OCR_CONTRACT_INVALID') {
      throw new HostError('INVALID_ENGINE_OUTPUT', 'The local OCR service returned an invalid versioned result.', 502, { cause: error });
    }
    throw error;
  }
}

async function handleRemovalRoutes(options) {
  const shared = {
    request: options.request, response: options.response, url: options.url,
    documentId: options.documentId, operation: options.operation, processing: options.processing,
    store: options.store, exactJsonObject, method, readJson, json,
  };
  if (await handleJavaScriptRemovalRoute({
    ...shared, javascriptRemoval: options.javascriptRemoval,
    bodyLimit: JAVASCRIPT_REMOVAL_JSON_BODY_LIMIT,
  })) return true;
  if (await handleAttachmentRemovalRoute({
    ...shared, attachmentRemoval: options.attachmentRemoval,
    bodyLimit: ATTACHMENT_REMOVAL_JSON_BODY_LIMIT,
  })) return true;
  return handleAnnotationFlattenRoute({
    ...shared, annotationFlatten: options.annotationFlatten,
    bodyLimit: ANNOTATION_FLATTEN_JSON_BODY_LIMIT,
  });
}

function apiRequestUrl(request, response, host, staticHandler) {
  let url;
  try {
    url = new URL(request.url ?? '/', `http://${host}`);
  } catch {
    json(response, 400, { error: { code: 'INVALID_PATH', message: 'Invalid request path.' } });
    return null;
  }
  if (!url.pathname.startsWith('/api/')) {
    staticHandler(request, response);
    return null;
  }
  return url;
}

function requestProcessing(request, response) {
  const controller = new AbortController();
  const cancel = () => {
    if (!response.writableEnded) controller.abort(new Error('Client disconnected'));
  };
  request.once('aborted', cancel);
  response.once('close', cancel);
  return { signal: controller.signal };
}

export function createAppHandler({
  staticHandler, store, service, inputs = null, conversion = null, workspaceState,
  domainFacade = null, aecArtifacts = null, projectBundles = null,
  rasterMutations = null, redactionPlans = null, redactionPlanReports = null,
  comparisons = null, prepress = null, accessibilityReviews = null,
  accessibilityRemediations = null, standardsValidations = null, incrementalMetadata = null,
  incrementalBleedBox = null, incrementalGoToLink = null, incrementalNamedDestination = null,
  incrementalPageVector = null, pageText = null, fullPageRedaction = null, printerMarks = null, pageBackground = null,
  incrementalPageTransition = null,
  layerDefaults = null,
  signingIdentityDirectory = null, certificateSignature = null, signingIdentityReady = false,
  hiddenDataSanitization = null,
  acroFormCheckbox = null, acroFormRadio = null, acroFormTextField = null, acroFormChoice = null, acroFormSignatureField = null, batesNumbering = null, aecMeasurementLegend = null,
  taggedRemediation = null, taggedRemediationReady = false,
  jpegImage = null, jpegImageReady = false,
  jpegImageReplacement = null, jpegImageReplacementReady = false,
  pageLabels = null, pageLabelsReady = false,
  advancedSearch = null, advancedSearchReady = false, specialistContent = null, specialistContentReady = false,
  incrementalAccessibilityMetadata = null, javascriptRemoval = null,
  attachmentRemoval = null, annotationFlatten = null, fastWebView = null,
  pdfkitInspections = null, pdfkitOutlineSplits = null, pdfkitMutations = null,
  pdfkitProtection = null, pdfkitSanitization = null, pdfkitTextFieldWidget = null, signatureTrustReady = false,
  ooxmlExport = null,
  pluginSandboxStatus = null,
  pluginPackages = null,
  scannerDiscovery = null, scannerDiscoveryReady = false,
  token, host, port,
}) {
  if (typeof staticHandler !== 'function' || !store || !service || !workspaceState || typeof token !== 'string') {
    throw new TypeError('createAppHandler requires staticHandler, store, service, workspaceState, and a session token.');
  }
  if (Boolean(inputs) !== Boolean(conversion)) {
    throw new TypeError('createAppHandler requires both inputs and conversion when conversion routes are enabled.');
  }
  return async (request, response) => {
    const url = apiRequestUrl(request, response, host, staticHandler);
    if (!url) return;
    const { pathname } = url;
    try {
      if (!isAllowedHost(request.headers.host, host, port)) throw new HostError('MISDIRECTED_REQUEST', 'Misdirected request.', 421);
      if (await handleBootstrapRoute({
        pathname, request, response, service, inputs, conversion, domainFacade, prepress, aecArtifacts,
        projectBundles, accessibilityRemediations, standardsValidations, incrementalMetadata, incrementalBleedBox, incrementalGoToLink, incrementalNamedDestination, incrementalPageVector, pageText, fullPageRedaction, printerMarks, pageBackground, layerDefaults, incrementalAccessibilityMetadata, javascriptRemoval, attachmentRemoval, annotationFlatten, fastWebView, pdfkitInspections, redactionPlans, redactionPlanReports,
        pdfkitOutlineSplits, pdfkitMutations, pdfkitProtection, pdfkitSanitization, pdfkitTextFieldWidget,
        signatureTrustReady, signingIdentityReady, hiddenDataSanitization, acroFormCheckbox, acroFormRadio, acroFormTextField, acroFormChoice, acroFormSignatureField, batesNumbering, aecMeasurementLegend, jpegImage, jpegImageReplacement, pageLabels, advancedSearch, specialistContent, scannerDiscovery, scannerDiscoveryReady, pluginSandboxProbeReady: Boolean(pluginSandboxStatus), token, method, requireLocalFetchMetadata, json, sanitizedEngineAvailability,
      })) return;
      if (!hasToken(request, token)) throw new HostError('UNAUTHORIZED', 'A valid local session token is required.', 401);
      requireSameOrigin(request);
      const processing = requestProcessing(request, response);
      if (await handlePluginPlatformRoute({ pathname, request, response, url, processing, pluginSandboxStatus, pluginPackages, method, readJson, readBytes, requireContentType, json })) return;
      if (await handleOcrRoute({ pathname, request, response, url, service, processing, method, json, readJson, normalizedOcrOptions, checkedOcrResult })) return;
      if (await handlePortableProjectImportRoute({ pathname, request, response, url, processing, projectBundles, method, requireContentType, json })) return;
      if (await handleComparisonBatchRoute({ pathname, request, response, processing, comparisons, method, readJson, json })) return;
      if (await handleConversionRoute({
        pathname, request, response, url, processing, store, inputs, conversion,
        method, json, empty, readJson, requireContentType, decodeDisplayName,
      })) return;
      if (await handleDomainCatalogRoute({ pathname, request, response, domainFacade, method, json })) return;
      if (await handleSigningIdentityListRoute({ pathname, request, response, url, signingIdentityDirectory, signingIdentityReady, processing, method, json })) return;
      if (await handleScannerDiscoveryRoute({ pathname, request, response, url, processing, scannerDiscovery, scannerDiscoveryReady, method, readJson, json, exactJsonObject })) return;

      if (await handleDocumentRoutes({ pathname, request, response, url, processing, store, workspaceState,
        routes: { workspace: handleWorkspaceRoute, workflow: handleWorkflowRoute, incrementalMetadata: handleIncrementalMetadataRoute,
          incrementalBleedBox: handleIncrementalBleedBoxRoute, incrementalGoToLink: handleIncrementalGoToLinkRoute,
          incrementalNamedDestination: handleIncrementalNamedDestinationRoute, incrementalPageVector: handleIncrementalPageVectorRoute, incrementalPageTransition: handleIncrementalPageTransitionRoute,
          pageText: handlePageTextRoute, ooxmlExport: handleOoxmlExportRoute, fullPageRedaction: handleFullPageRedactionRoute, fullPageRedactionBatch: handleFullPageRedactionBatchRoute, printerMarks: handlePrinterMarksRoute, pageBackground: handlePageBackgroundRoute, specialistContent: handleSpecialistContentRoute, layerDefaults: handleLayerDefaultsRoute,
          certificateSign: handleCertificateSignRoute, hiddenDataSanitization: handleHiddenDataSanitizationRoute, acroFormCheckbox: handleAcroFormCheckboxRoute, acroFormRadio: handleAcroFormRadioRoute, acroFormTextField: handleAcroFormTextFieldRoute, acroFormSignatureField: handleAcroFormSignatureFieldRoute, aecMeasurementLegend: handleAecMeasurementLegendRoute, taggedRemediation: handleTaggedRemediationRoute, jpegImage: handleJpegImageRoute, jpegImageReplacement: handleJpegImageReplacementRoute, pageLabels: handlePageLabelsRoute, advancedSearch: handleAdvancedSearchRoute, incrementalAccessibilityMetadata: handleIncrementalAccessibilityMetadataRoute,
          removal: handleRemovalRoutes, fastWebView: handleFastWebViewRoute, copyPage: handleCopyPageRoute, pdfkit: handlePdfkitRoute, acroFormChoice: handleAcroFormChoiceRoute, batesNumbering: handleBatesNumberingRoute, documentService: handleDocumentServiceRoute },
        limits: { incrementalMetadata: INCREMENTAL_METADATA_JSON_BODY_LIMIT, incrementalBleedBox: INCREMENTAL_BLEED_BOX_JSON_BODY_LIMIT,
          incrementalGotoLink: INCREMENTAL_GOTO_LINK_JSON_BODY_LIMIT, incrementalNamedDestination: INCREMENTAL_NAMED_DESTINATION_JSON_BODY_LIMIT,
          incrementalPageVector: INCREMENTAL_PAGE_VECTOR_JSON_BODY_LIMIT, incrementalPageTransition: INCREMENTAL_PAGE_TRANSITION_JSON_BODY_LIMIT, pageText: PAGE_TEXT_JSON_BODY_LIMIT, fullPageRedaction: FULL_PAGE_REDACTION_JSON_BODY_LIMIT, fullPageRedactionBatch: FULL_PAGE_REDACTION_BATCH_JSON_BODY_LIMIT, printerMarks: PRINTER_MARKS_JSON_BODY_LIMIT, pageBackground: PAGE_BACKGROUND_JSON_BODY_LIMIT,
          layerDefaults: LAYER_DEFAULTS_JSON_BODY_LIMIT, specialistContent: SPECIALIST_CONTENT_JSON_BODY_LIMIT, certificateSignature: CERTIFICATE_SIGNATURE_JSON_BODY_LIMIT, hiddenDataSanitization: HIDDEN_DATA_SANITIZATION_JSON_BODY_LIMIT, taggedRemediation: 128 * 1024, jpegImage: 2_048, jpegImageReplacement: 2_048, pageLabels: 8_192, advancedSearch: 4_096,
          incrementalAccessibilityMetadata: INCREMENTAL_ACCESSIBILITY_METADATA_JSON_BODY_LIMIT, copyPage: COPY_PAGE_JSON_BODY_LIMIT,
          pdfkit: PDFKIT_TEXT_FIELD_WIDGET_JSON_BODY_LIMIT, ooxmlExport: OOXML_EXPORT_JSON_BODY_LIMIT, acroFormChoice: 16_384, batesNumbering: 8_192, fastWebView: FAST_WEB_VIEW_JSON_BODY_LIMIT, pdfkitMutation: PDFKIT_MUTATION_JSON_BODY_LIMIT, pdfkitProtection: PDFKIT_PROTECTION_JSON_BODY_LIMIT },
        ...{ domainFacade, aecArtifacts, projectBundles, method, json, empty, write, readJson, readBytes, parsePositiveInteger, requireContentType,
          sendPortableProject, rasterMutations, redactionPlans, comparisons, prepress, accessibilityReviews, accessibilityRemediations,
          standardsValidations, redactionPlanReports, incrementalMetadata, incrementalBleedBox, incrementalGoToLink, incrementalNamedDestination,
          incrementalPageVector, incrementalPageTransition, pageText, fullPageRedaction, printerMarks, pageBackground, specialistContent, specialistContentReady, layerDefaults, certificateSignature, signingIdentityReady, hiddenDataSanitization, taggedRemediation, taggedRemediationReady, jpegImage, jpegImageReady, pageLabels, pageLabelsReady, advancedSearch, advancedSearchReady, incrementalAccessibilityMetadata,
          javascriptRemoval, attachmentRemoval, annotationFlatten, fastWebView, ooxmlExport, acroFormCheckbox, acroFormRadio, acroFormTextField, acroFormSignatureField, aecMeasurementLegend, jpegImageReplacement, jpegImageReplacementReady, service, conversion, pdfkitInspections, pdfkitOutlineSplits, pdfkitMutations,
          pdfkitProtection, pdfkitSanitization, pdfkitTextFieldWidget, acroFormChoice, batesNumbering, exactJsonObject, normalizedOcrOptions, checkedOcrResult, sendArtifact, parseSnapshotRegion }})) return;
      if (await handleArtifactRoute({ pathname, request, response, url, store, method, empty, sendArtifact })) return;
      throw new HostError('NOT_FOUND', 'Local API endpoint not found.', 404);
    } catch (error) {
      if (response.destroyed) return;
      const hostError = asHostError(error);
      json(response, hostError.status, { error: { code: hostError.code, message: hostError.message } });
    }
  };
}

export { decodeDisplayName, hasToken, parsePositiveInteger, readBytes, readJson, requireLocalFetchMetadata, requireSameOrigin };
