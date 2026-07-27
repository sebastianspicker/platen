function createGenerationActions(context) {
  const { controllers: { generation, domain, aec, scanner, bates } } = context;
  return {
    'create-blank-document': () => generation.createLocalDocument('blank'),
    'create-text-document': () => generation.createLocalDocument('text'),
    'create-from-clipboard': generation.createFromClipboard,
    'create-clipboard-to-pdf': generation.createClipboardToPdf,
    'run-domain-operation': domain.runDomainOperation,
    'create-aec-calibration': aec.createAecCalibration,
    'create-aec-measurement': aec.createAecMeasurement,
    'publish-aec-measurement': aec.publishAecMeasurement,
    'generate-aec-measurement-legend': aec.generateAecMeasurementLegend,
    'discover-scanners': scanner?.discoverScanners ?? (() => {}),
    'run-bates-numbering': bates?.runBatesNumbering ?? (() => {}),
    'export-project-bundle': domain.exportProjectBundle,
  };
}

function createPrimaryCompositionActions(context) {
  const { controllers: { pageComposition }, documentApi } = context;
  return {
    'extract-page': pageComposition.extractSelectedPage,
    'export-arrangement': pageComposition.exportArrangement,
    'choose-merge-file': () => documentApi.querySelector('#merge-picker')?.click(),
    'split-document': pageComposition.splitDocument,
    'split-by-rule': pageComposition.splitDocumentByRule,
    'split-verified-outline': pageComposition.splitVerifiedTopLevelOutline,
    'duplicate-page': pageComposition.duplicateSelectedPage,
    'reverse-pages': pageComposition.reverseDocumentPages,
  };
}

function createSecondaryCompositionActions(context) {
  const { controllers: { pageComposition }, documentApi } = context;
  return {
    'choose-interleave-file': () => documentApi.querySelector('#interleave-picker')?.click(),
    'choose-scan-page-file': () => documentApi.querySelector('#scan-append-picker')?.click(),
    'choose-insert-file': () => documentApi.querySelector('#insert-picker')?.click(),
    'choose-replace-file': () => documentApi.querySelector('#replace-picker')?.click(),
    'choose-copy-page-file': () => documentApi.querySelector('#copy-page-picker')?.click(),
    'insert-blank-page': pageComposition.insertBlankPage,
    'move-page-back': () => pageComposition.moveSelectedPage(-1),
    'move-page-forward': () => pageComposition.moveSelectedPage(1),
    'remove-page': pageComposition.removeSelectedPage,
    'restore-page-order': pageComposition.restorePageOrder,
  };
}

function createComparisonActions(context) {
  const { controllers: { comparison }, documentApi } = context;
  return {
    'choose-comparison-file': () => documentApi.querySelector('#comparison-picker')?.click(),
    'export-comparison-json': () => comparison.exportComparison('json'),
    'export-comparison-csv': () => comparison.exportComparison('csv'),
  };
}

function createRedactionPlanActions({ controllers: { raster } }) {
  return {
    'create-full-page-object-redaction': raster.runFullPageRedaction,
    'create-redaction-plan': raster.createRedactionPlan,
    'apply-redaction-plan': raster.applyRedactionPlan,
    'export-redaction-plan-report': raster.exportRedactionPlanReport,
  };
}

export function createApplicationDocumentActions(context) {
  return {
    ...createGenerationActions(context),
    ...createPrimaryCompositionActions(context),
    ...createSecondaryCompositionActions(context),
    ...createComparisonActions(context),
    ...createRedactionPlanActions(context),
  };
}
