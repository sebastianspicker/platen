function mockOcrDocumentResult(documentId, {
  language = 'eng', cleanupPreset = 'document', segmentation = 'auto',
} = {}) {
  const cleanupReceipts = [{
    page: 1, preset: cleanupPreset, applied: cleanupPreset !== 'none', canvasPreserved: true,
    pre: { sha256: 'c'.repeat(64), width: 1, height: 1 },
    post: { sha256: 'd'.repeat(64), width: 1, height: 1 },
  }];
  return {
    kind: 'searchable-ocr-document', schemaVersion: 1, sourceDigest: 'a'.repeat(64),
    artifact: {
      id: 'ocr-artifact', documentId, displayName: 'ocr.pdf', mediaType: 'application/pdf',
      size: 1, sha256: 'b'.repeat(64),
      operation: {
        schemaVersion: 1, type: 'searchable-ocr',
        inputs: [{ documentId, sha256: 'a'.repeat(64) }],
        parameters: { cleanupReceipts, userDictionary: { termCount: 0, digest: null } },
        validation: { passed: true, recognizedWordCount: 1 },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    result: {
      language, pageCount: 1, recognizedWordCount: 1, rasterized: true,
      cleanupPreset, segmentation, userDictionary: { termCount: 0, digest: null }, suspects: [],
    },
    evidence: {
      localOnly: true, sourceBound: true, rasterized: true, reviewRequired: true,
      engines: cleanupPreset === 'none'
        ? ['Poppler', 'Tesseract'] : ['Poppler', 'ImageMagick', 'Tesseract'],
      cleanupReceipts,
    },
    limitations: ['Review OCR output against the source.'],
  };
}

function mockOcrLayoutResult(options) {
  return {
    kind: 'ocr-layout-evidence', schemaVersion: 1, sourceDigest: 'a'.repeat(64),
    language: options.language, cleanupPreset: options.cleanupPreset,
    segmentation: options.segmentation, detectTables: options.detectTables,
    records: [{
      page: options.pages[0],
      pageSize: { page: options.pages[0], widthPoints: 612, heightPoints: 792 },
      zoneId: 'image-1', zoneType: 'image', region: { x: 0, y: 0, width: 1, height: 1 },
      dpi: 300, classificationOnly: true, recognizedWordCount: 0,
      layout: null, tableCandidates: [], alto: null,
    }],
    evidence: {
      localOnly: true, sourceBound: true, engines: ['Poppler', 'ImageMagick', 'Tesseract'],
      tableMethod: options.detectTables ? 'tesseract-tsv-geometry-heuristic' : null,
      reviewRequired: options.detectTables,
    },
    limitations: ['Coordinates require review.', 'Tables are geometry heuristics.'],
  };
}

export function createDocumentOverlays() {
  const service = {
    availability: async () => [{
      name: 'pdfinfo', version: '26.07.0', available: true, executable: '/private/path',
    }],
    inspect: async () => ({ pageCount: 1 }),
    inspectStructure: async (_documentId, options) => ({ pageCount: 1, options }),
    extractText: async () => [{ page: 1, text: 'fixture' }],
    renderThumbnail: async () => Buffer.from([137, 80, 78, 71]),
    renderCropBoxPage: async () => Buffer.from([137, 80, 78, 71]),
    renderCropBoxSnapshot: async () => Buffer.from([137, 80, 78, 71]),
    listFonts: async () => [],
    listImages: async () => [],
    listAttachments: async () => [],
    verifySignatures: async () => ({
      schemaVersion: 1, profile: 'poppler-offline-integrity-v1', status: 'unsigned',
      integrityStatus: 'unsigned', coverageStatus: 'unsigned',
      currentDocumentStatus: 'unsigned', count: 0, signatureCount: 0,
      summary: 'No embedded signatures', signatures: [], limitations: [],
    }),
    extractPages: async () => ({ id: 'artifact' }),
    arrangePages: async (_documentId, pages) => ({ id: 'arranged', pages }),
    mergeDocuments: async (_documentId, secondaryDocumentId) => ({ id: 'merged', secondaryDocumentId }),
    copyPageBetweenDocuments: async (
      _documentId, secondaryDocumentId, request,
    ) => ({ id: 'copied-page', secondaryDocumentId, request }),
    splitDocument: async () => [{ id: 'split-1' }],
    splitByPageCount: async (_documentId, pagesPerOutput) => [{ id: 'split-rule-1', pagesPerOutput }],
    duplicatePages: async (_documentId, pages) => ({ id: 'duplicated', pages }),
    reversePages: async () => ({ id: 'reversed' }),
    interleaveDocuments: async (_documentId, secondaryDocumentId) => ({ id: 'interleaved', secondaryDocumentId }),
    insertDocument: async (_documentId, secondaryDocumentId, afterPage) => ({ id: 'inserted', secondaryDocumentId, afterPage }),
    replacePages: async (_documentId, secondaryDocumentId, startPage, endPage) => ({ id: 'replaced', secondaryDocumentId, startPage, endPage }),
    ocrLanguages: async () => ['eng'],
    ocrDocument: async (documentId, options) => mockOcrDocumentResult(documentId, options),
    analyzeOcrLayout: async (_documentId, options) => mockOcrLayoutResult(options),
    ocrBatchDocuments: async (requests) => ({
      kind: 'ocr-batch-manifest', schemaVersion: 1, status: 'succeeded',
      requests: requests.map((entry) => ({
        id: entry.id, documentId: entry.documentId, kind: 'document', status: 'completed',
        output: mockOcrDocumentResult(entry.documentId, entry.options),
      })),
      evidence: {
        localOnly: true, sourceBound: true, engines: ['Poppler', 'ImageMagick', 'Tesseract'],
        ordered: true, sequential: true, aggregatePages: requests.length,
        aggregateInputBytes: requests.length, aggregateOutputBytes: requests.length,
      },
      limitations: ['Sequential local test batch.'],
    }),
  };
  const conversion = {
    createBlank: async (options) => ({ id: 'blank', options }),
    createText: async (options) => ({ id: 'text', options }),
    convertInput: async (inputId) => ({ id: 'converted', inputId }),
    rewriteDocument: async (documentId, mode) => ({ id: 'rewritten', documentId, mode }),
  };
  const rasterMutations = {
    rotatePages: async (documentId, parameters) => ({ id: 'raster-rotate', documentId, parameters }),
    cropPages: async (documentId, parameters) => ({ id: 'raster-crop', documentId, parameters }),
    resizePages: async (documentId, parameters) => ({ id: 'raster-resize', documentId, parameters }),
    addOverlayText: async (documentId, parameters) => ({ id: 'raster-overlay', documentId, parameters }),
    redact: async (documentId, parameters) => ({ id: 'raster-redact', documentId, parameters }),
    flatten: async (documentId, parameters) => ({ id: 'raster-flatten', documentId, parameters }),
  };
  return { service, conversion, rasterMutations };
}
